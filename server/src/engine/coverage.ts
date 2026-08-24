/**
 * Coverage — the single authority on "which months does this user actually
 * have data for, and which of those months are COMPLETE?"
 *
 * Every monthly average in the app must be built from this module's answers.
 * The invariants it enforces (audit D4/D5/D6 — the partial-month bug family):
 *
 *   - An incomplete month is never included in a mean, and never counted in
 *     the denominator.
 *   - A month with genuinely zero activity INSIDE the covered range is a real
 *     zero: it is complete and it counts.
 *   - A month OUTSIDE the covered range is absent — not zero — and does not
 *     count.
 *
 * Coverage is derived per account from the transactions themselves (the range
 * [first txn date .. last txn date] is what the data actually witnesses), and
 * persisted in `coverage_periods`. The table also accepts statement-sourced
 * rows (`source = 'statement'`, written by upload code when statement periods
 * are known); those union with the derived range and can describe
 * discontinuous coverage (a missing statement leaves a hole).
 *
 * A month is COMPLETE for a user iff:
 *   1. the month has fully elapsed (its last day is before today), and
 *   2. at least one account covers it, and
 *   3. EVERY account whose coverage touches the month covers the whole month
 *      (with a small tolerance at the month edges, EDGE_TOLERANCE_DAYS: a
 *      statement that starts on the 1st often posts its first transaction a
 *      day or two in).
 *
 * Rule 3 is deliberately conservative: if the checking data stops on the 18th,
 * the month's income/expenses are genuinely unknown, so the month is PARTIAL
 * and excluded from every mean. This replaces the old "drop the oldest month
 * if its first transaction is after day 10" heuristic that was duplicated in
 * reports.ts — that guess is gone; this module is the ONLY place completeness
 * is decided.
 *
 * All date math is pure string/epoch-day arithmetic (no `new Date(string)`
 * local/UTC mixing — audit D15).
 */
import crypto from 'crypto';
import { db as defaultDb } from '../db/database.js';
import type { Sql } from '../db/sql.js';

/** Days of slack at each month edge when judging whether an account covers a whole month. */
export const EDGE_TOLERANCE_DAYS = 3;

export type MonthStatus = 'complete' | 'partial' | 'absent';

/** Inclusive day interval, in epoch days. */
interface Interval {
  start: number;
  end: number;
}

export interface AccountCoverage {
  accountId: string;
  /** Merged, sorted, non-overlapping covered intervals. */
  intervals: Interval[];
}

export interface UserCoverage {
  accounts: AccountCoverage[];
  /** First covered epoch day across all accounts, or null when no coverage. */
  firstDay: number | null;
  /** Last covered epoch day across all accounts, or null when no coverage. */
  lastDay: number | null;
  /** Epoch day of "today" the statuses are evaluated against. */
  today: number;
}

// ---------------------------------------------------------------------------
// Pure date helpers (string / epoch-day math only)
// ---------------------------------------------------------------------------

export function epochDay(dateStr: string): number {
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return 0;
  return Math.round(Date.UTC(y, m - 1, d) / 86400000);
}

function daysInMonth(year: number, month1: number): number {
  // Day 0 of the next month is the last day of this month (UTC, no tz drift).
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** 'YYYY-MM' of a 'YYYY-MM-DD' string. */
export function ymOf(dateStr: string): string {
  return String(dateStr).slice(0, 7);
}

export function monthStartIso(ym: string): string {
  return `${ym}-01`;
}

export function monthEndIso(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  return `${ym}-${String(daysInMonth(y, m)).padStart(2, '0')}`;
}

function monthStartDay(ym: string): number {
  return epochDay(monthStartIso(ym));
}

function monthEndDay(ym: string): number {
  return epochDay(monthEndIso(ym));
}

export function prevYm(ym: string): string {
  let [y, m] = ym.split('-').map(Number);
  m -= 1;
  if (m === 0) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function nextYm(ym: string): string {
  let [y, m] = ym.split('-').map(Number);
  m += 1;
  if (m === 13) { m = 1; y += 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** Current calendar month, 'YYYY-MM' (server-local clock, matching the rest of the app). */
export function currentYm(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function todayIso(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Schema (additive, idempotent, portable — mirrors providers/schema.ts)
// ---------------------------------------------------------------------------

const TABLES = `
  CREATE TABLE IF NOT EXISTS coverage_periods (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    period_start TEXT NOT NULL,
    period_end   TEXT NOT NULL,
    source       TEXT NOT NULL DEFAULT 'derived',  -- 'derived' | 'statement' | 'manual'
    file_id      TEXT,
    txn_count    INTEGER NOT NULL DEFAULT 0,
    computed_at  TEXT
  );
`;

const INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_coverage_periods_user_account ON coverage_periods(user_id, account_id);
`;

/**
 * Apply the coverage schema. Idempotent; goes through db.exec() so the
 * Postgres driver's translateDdl() applies. NOT added to database.ts's
 * SQLite-only migrations array — that path never reaches Postgres.
 */
export async function applyCoverageSchema(sql: Sql): Promise<void> {
  await sql.exec(TABLES);
  await sql.exec(INDEXES);
}

let schemaReady: Promise<void> | null = null;

async function ensureSchema(sql: Sql): Promise<void> {
  if (sql !== defaultDb) {
    // Test/one-off connections apply directly (cheap, idempotent).
    await applyCoverageSchema(sql);
    return;
  }
  if (!schemaReady) {
    schemaReady = applyCoverageSchema(sql).catch((err) => { schemaReady = null; throw err; });
  }
  await schemaReady;
}

// ---------------------------------------------------------------------------
// Derivation & persistence
// ---------------------------------------------------------------------------

/**
 * Recompute the derived (transaction-witnessed) coverage rows for a user and
 * persist any changes. Statement-sourced rows are never touched. Cheap when
 * nothing changed: one grouped aggregate + one read, no writes.
 */
export async function refreshDerivedCoverage(sql: Sql, userId: string): Promise<void> {
  await ensureSchema(sql);

  const live = await sql.all(
    `SELECT account_id, MIN(date) as min_date, MAX(date) as max_date, COUNT(*) as txn_count
     FROM transactions
     WHERE user_id = ?
     GROUP BY account_id`, userId,
  ) as Array<{ account_id: string; min_date: string; max_date: string; txn_count: number }>;

  const stored = await sql.all(
    `SELECT id, account_id, period_start, period_end, txn_count
     FROM coverage_periods
     WHERE user_id = ? AND source = 'derived'`, userId,
  ) as Array<{ id: string; account_id: string; period_start: string; period_end: string; txn_count: number }>;

  const storedByAccount = new Map(stored.map((r) => [r.account_id, r]));
  const liveAccounts = new Set(live.map((r) => r.account_id));
  const now = new Date().toISOString();

  const inserts: Array<{ id: string; accountId: string; start: string; end: string; count: number }> = [];
  const updates: Array<{ id: string; start: string; end: string; count: number }> = [];
  const deletes: string[] = [];

  for (const row of live) {
    const prev = storedByAccount.get(row.account_id);
    const start = String(row.min_date).slice(0, 10);
    const end = String(row.max_date).slice(0, 10);
    if (!prev) {
      inserts.push({ id: crypto.randomUUID(), accountId: row.account_id, start, end, count: row.txn_count });
    } else if (prev.period_start !== start || prev.period_end !== end || prev.txn_count !== row.txn_count) {
      updates.push({ id: prev.id, start, end, count: row.txn_count });
    }
  }
  for (const row of stored) {
    if (!liveAccounts.has(row.account_id)) deletes.push(row.id);
  }

  if (inserts.length === 0 && updates.length === 0 && deletes.length === 0) return;

  await sql.tx(async (t) => {
    for (const ins of inserts) {
      await t.run(
        `INSERT INTO coverage_periods (id, user_id, account_id, period_start, period_end, source, txn_count, computed_at)
         VALUES (?, ?, ?, ?, ?, 'derived', ?, ?)`,
        ins.id, userId, ins.accountId, ins.start, ins.end, ins.count, now,
      );
    }
    for (const upd of updates) {
      await t.run(
        `UPDATE coverage_periods SET period_start = ?, period_end = ?, txn_count = ?, computed_at = ?
         WHERE id = ?`,
        upd.start, upd.end, upd.count, now, upd.id,
      );
    }
    for (const id of deletes) {
      await t.run(`DELETE FROM coverage_periods WHERE id = ?`, id);
    }
  });
}

/** Merge intervals that overlap or are adjacent (gap of 0 days). */
function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const iv of sorted) {
    const last = merged[merged.length - 1];
    if (last && iv.start <= last.end + 1) {
      if (iv.end > last.end) last.end = iv.end;
    } else {
      merged.push({ start: iv.start, end: iv.end });
    }
  }
  return merged;
}

/**
 * Load the user's coverage (refreshing derived rows first). Hidden accounts do
 * not participate — they are excluded from every report already.
 */
export async function getCoverage(userId: string, sql: Sql = defaultDb): Promise<UserCoverage> {
  await refreshDerivedCoverage(sql, userId);

  const rows = await sql.all(
    `SELECT cp.account_id, cp.period_start, cp.period_end
     FROM coverage_periods cp
     JOIN accounts a ON a.id = cp.account_id
     WHERE cp.user_id = ? AND COALESCE(a.is_hidden, 0) = 0`, userId,
  ) as Array<{ account_id: string; period_start: string; period_end: string }>;

  const byAccount = new Map<string, Interval[]>();
  for (const r of rows) {
    const start = epochDay(r.period_start);
    const end = epochDay(r.period_end);
    if (end < start) continue;
    const list = byAccount.get(r.account_id) || [];
    list.push({ start, end });
    byAccount.set(r.account_id, list);
  }

  const accounts: AccountCoverage[] = [];
  let firstDay: number | null = null;
  let lastDay: number | null = null;
  for (const [accountId, intervals] of byAccount) {
    const merged = mergeIntervals(intervals);
    accounts.push({ accountId, intervals: merged });
    for (const iv of merged) {
      if (firstDay === null || iv.start < firstDay) firstDay = iv.start;
      if (lastDay === null || iv.end > lastDay) lastDay = iv.end;
    }
  }

  return { accounts, firstDay, lastDay, today: epochDay(todayIso()) };
}

// ---------------------------------------------------------------------------
// Month classification (pure — operate on a loaded UserCoverage)
// ---------------------------------------------------------------------------

/**
 * Classify one month against loaded coverage.
 *   complete — fully elapsed, covered, and no account is missing part of it
 *   partial  — some coverage touches the month, but a chunk of it is unwitnessed
 *              (or the month has not fully elapsed yet — the current month is
 *              never complete)
 *   absent   — no coverage touches the month at all
 */
export function monthStatus(cov: UserCoverage, ym: string): MonthStatus {
  const s = monthStartDay(ym);
  const e = monthEndDay(ym);

  let touching = 0;
  let fullyCovering = 0;
  for (const acct of cov.accounts) {
    let touches = false;
    let full = false;
    for (const iv of acct.intervals) {
      if (iv.end < s || iv.start > e) continue;
      touches = true;
      if (iv.start <= s + EDGE_TOLERANCE_DAYS && iv.end >= e - EDGE_TOLERANCE_DAYS) full = true;
    }
    if (touches) {
      touching++;
      if (full) fullyCovering++;
    }
  }

  if (touching === 0) return 'absent';
  if (fullyCovering < touching) return 'partial';
  return e < cov.today ? 'complete' : 'partial';
}

/** Pure variant of completeMonths() over preloaded coverage. Newest first. */
export function completeMonthsFromCoverage(cov: UserCoverage, n: number): string[] {
  if (cov.firstDay === null || cov.lastDay === null || n <= 0) return [];
  const firstYm = ymOf(new Date(cov.firstDay * 86400000).toISOString());
  const months: string[] = [];
  // The current month can never be complete; start the walk one month back.
  let ym = prevYm(currentYm());
  while (months.length < n && ym >= firstYm) {
    if (monthStatus(cov, ym) === 'complete') months.push(ym);
    ym = prevYm(ym);
  }
  return months;
}

/** Pure variant of monthsWithData() over preloaded coverage. Oldest first. */
export function monthsWithDataFromCoverage(
  cov: UserCoverage,
  fromYm: string,
  toYm: string,
): Array<{ month: string; status: MonthStatus }> {
  const out: Array<{ month: string; status: MonthStatus }> = [];
  if (fromYm > toYm) return out;
  let ym = fromYm;
  // Hard cap so a malformed range can never loop unbounded (100 years).
  for (let guard = 0; guard < 1200 && ym <= toYm; guard++) {
    const status = monthStatus(cov, ym);
    if (status !== 'absent') out.push({ month: ym, status });
    ym = nextYm(ym);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Async convenience API (load + classify in one call)
// ---------------------------------------------------------------------------

/** Is `ym` ('YYYY-MM') a complete month for this user? */
export async function isMonthComplete(userId: string, ym: string, sql: Sql = defaultDb): Promise<boolean> {
  const cov = await getCoverage(userId, sql);
  return monthStatus(cov, ym) === 'complete';
}

/**
 * The user's `n` most recent complete months, newest first (['2026-07', ...]).
 * Partial months are skipped, not counted; genuinely-zero-activity months
 * inside the covered range ARE included. May return fewer than `n`.
 */
export async function completeMonths(userId: string, n: number, sql: Sql = defaultDb): Promise<string[]> {
  const cov = await getCoverage(userId, sql);
  return completeMonthsFromCoverage(cov, n);
}

/**
 * Months in ['YYYY-MM' from..to] that have any coverage, each labelled
 * complete/partial. Months outside the covered range are omitted entirely —
 * they are absent, not zero.
 */
export async function monthsWithData(
  userId: string,
  fromYm: string,
  toYm: string,
  sql: Sql = defaultDb,
): Promise<Array<{ month: string; status: MonthStatus }>> {
  const cov = await getCoverage(userId, sql);
  return monthsWithDataFromCoverage(cov, fromYm, toYm);
}
