/**
 * Timezone-safe date-only helpers.
 *
 * The bug class this file exists to kill (audit D15): `new Date('YYYY-MM-DD')`
 * parses as UTC *midnight*, while `setDate`/`getDate`/`toISOString` round-trips
 * mix in the process's local timezone. On any server west of UTC that shifts a
 * calendar date by one day near midnight, which silently moves duplicate
 * windows, recurring grids, and interval math.
 *
 * Everything here is pure integer/string math on `YYYY-MM-DD` strings — no
 * `Date` object ever carries a date-only value, so the process timezone can
 * never leak in.
 */

/** Days since 1970-01-01 for a `YYYY-MM-DD` string. NaN when unparseable. */
export function epochDay(dateStr: string): number {
  const s = String(dateStr).slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return NaN;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return NaN;
  // Date.UTC is calendar arithmetic only — no timezone involved.
  return Math.round(Date.UTC(y, mo - 1, d) / 86_400_000);
}

/** Inverse of epochDay: integer day number back to `YYYY-MM-DD`. */
export function fromEpochDay(day: number): string {
  const d = new Date(day * 86_400_000);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${dd}`;
}

/** `dateStr + n` calendar days. Returns the input unchanged if unparseable. */
export function addDays(dateStr: string, n: number): string {
  const e = epochDay(dateStr);
  if (Number.isNaN(e)) return String(dateStr).slice(0, 10);
  return fromEpochDay(e + n);
}

/** Signed whole days from `a` to `b` (positive when b is later). */
export function diffDays(a: string, b: string): number {
  return epochDay(b) - epochDay(a);
}

/** Absolute whole days between two dates. */
export function daysApart(a: string, b: string): number {
  return Math.abs(diffDays(a, b));
}

/** Day of month (1–31), 0 when unparseable. */
export function dayOfMonth(dateStr: string): number {
  const m = /^\d{4}-\d{2}-(\d{2})/.exec(String(dateStr).slice(0, 10));
  return m ? Number(m[1]) : 0;
}

/** `YYYY-MM` month key. */
export function monthKey(dateStr: string): string {
  return String(dateStr).slice(0, 7);
}

/** Number of days in the month containing `year-month` (1-based month). */
export function daysInMonth(year: number, month: number): number {
  // Day 0 of the next month = last day of this month; still pure UTC math.
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** {year, month(1-based)} for a date string. */
export function yearMonth(dateStr: string): { year: number; month: number } {
  const s = String(dateStr).slice(0, 10);
  return { year: Number(s.slice(0, 4)), month: Number(s.slice(5, 7)) };
}

/**
 * The epoch day a monthly grid hits in a given (year, month) for an anchor
 * day-of-month, clamped to the month's length (anchor 31 → Feb 28/29).
 */
export function gridDayInMonth(year: number, month: number, dom: number): number {
  const clamped = Math.min(Math.max(1, dom), daysInMonth(year, month));
  return Math.round(Date.UTC(year, month - 1, clamped) / 86_400_000);
}

/** Today's calendar date in UTC as `YYYY-MM-DD`. */
export function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}
