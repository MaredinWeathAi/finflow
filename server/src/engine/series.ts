/**
 * Recurring-series persistence: `recurring_series` + `series_occurrences`.
 *
 * The audit's D17: `recurring_expenses.price_history` is a write-only JSON
 * blob — nothing appends to it, so the price-hike insight almost never fires.
 * This module derives price history from the transactions themselves: every
 * time detection runs, the matched transactions are recorded as observed
 * occurrences of their series, which makes price changes directly observable.
 *
 * Ownership notes:
 *   - `detectAndPersistSeries(db, userId)` is the entry point the recurring
 *     route (owned elsewhere) should call alongside/instead of raw
 *     `detectRecurring`.
 *   - `getSeriesPriceHistory(db, userId)` and `detectPriceHikes(db, userId)`
 *     are the clean query functions insights.ts (owned elsewhere) can adopt to
 *     replace the price_history blob parsing at insights.ts:454-471.
 *
 * Schema follows the providers/schema.ts pattern: additive, idempotent,
 * portable SQL (runs on SQLite in dev and Postgres in prod via translateDdl).
 * Deliberately NOT added to the SQLite-only migrations array in database.ts.
 */

import crypto from 'node:crypto';
import type { Sql } from '../db/sql.js';
import { detectRecurring, type RecurringCandidate, type RecurringFrequency } from './recurring-detector.js';
import { addDays } from '../lib/dates.js';
import { median } from '../lib/stats.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const TABLES = `
  CREATE TABLE IF NOT EXISTS recurring_series (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    core_name         TEXT NOT NULL,
    display_name      TEXT NOT NULL,
    direction         TEXT NOT NULL,             -- 'inflow' | 'outflow'
    cadence           TEXT NOT NULL,             -- weekly|biweekly|semi-monthly|monthly|quarterly|semi-annual|annual
    anchor_date       TEXT NOT NULL,             -- latest observed occurrence
    dom_pattern       TEXT,                      -- JSON day-of-month list, e.g. '[1,15]'
    amount_median     REAL NOT NULL,
    amount_mad        REAL NOT NULL,
    amount_dispersion REAL,
    first_seen        TEXT NOT NULL,
    last_seen         TEXT NOT NULL,
    occurrences       INTEGER NOT NULL DEFAULT 0,
    confidence        REAL NOT NULL,
    status            TEXT NOT NULL DEFAULT 'active',   -- active|paused|ended|user_dismissed|user_confirmed
    category_id       TEXT,
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL,
    UNIQUE (user_id, core_name, direction)
  );

  CREATE TABLE IF NOT EXISTS series_occurrences (
    series_id      TEXT NOT NULL REFERENCES recurring_series(id) ON DELETE CASCADE,
    transaction_id TEXT NOT NULL,
    date           TEXT NOT NULL,               -- observed transaction date
    expected_date  TEXT,                        -- grid date, when known
    amount         REAL NOT NULL,
    PRIMARY KEY (series_id, transaction_id)
  );
`;

const INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_recurring_series_user ON recurring_series(user_id, status);
  CREATE INDEX IF NOT EXISTS idx_series_occurrences_series_date ON series_occurrences(series_id, date);
`;

/** Apply the series schema. Idempotent; safe on SQLite and Postgres. */
export async function applySeriesSchema(db: Sql): Promise<void> {
  await db.exec(TABLES);
  await db.exec(INDEXES);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SeriesRow {
  id: string;
  user_id: string;
  core_name: string;
  display_name: string;
  direction: 'inflow' | 'outflow';
  cadence: string;
  anchor_date: string;
  dom_pattern: string | null;
  amount_median: number;
  amount_mad: number;
  amount_dispersion: number | null;
  first_seen: string;
  last_seen: string;
  occurrences: number;
  confidence: number;
  status: string;
  category_id: string | null;
}

export interface SeriesSyncResult {
  seriesUpserted: number;
  occurrencesRecorded: number;
  seriesPaused: number;
  series: SeriesRow[];
}

export interface PricePoint {
  transaction_id: string;
  date: string;
  amount: number;
}

export interface SeriesPriceHistory {
  seriesId: string;
  name: string;
  coreName: string;
  direction: 'inflow' | 'outflow';
  cadence: string;
  points: PricePoint[];   // ordered by date ascending
}

export interface PriceHike {
  seriesId: string;
  name: string;
  cadence: string;
  oldAmount: number;      // median of the established baseline
  newAmount: number;      // median of the 2 most recent occurrences
  pctChange: number;      // (new − old) / old
  annualDelta: number;    // extra dollars per year at this cadence
}

/** Occurrences per year for a cadence (used to annualize price deltas). */
export function occurrencesPerYear(cadence: RecurringFrequency | string): number {
  switch (cadence) {
    case 'weekly': return 52;
    case 'biweekly': return 26;
    case 'semi-monthly': return 24;
    case 'monthly': return 12;
    case 'quarterly': return 4;
    case 'semi-annual': return 2;
    case 'annual': return 1;
    default: return 12;
  }
}

function nominalPeriodDays(cadence: string): number {
  return 365.25 / occurrencesPerYear(cadence);
}

// ---------------------------------------------------------------------------
// Detection + persistence
// ---------------------------------------------------------------------------

interface TxnRow {
  id: string;
  name: string;
  amount: number;
  date: string;
  flow_type: string | null;
  category_id: string | null;
  category_name: string | null;
  category_icon: string | null;
  category_color: string | null;
}

/**
 * Run recurring detection over the user's history and persist the results as
 * `recurring_series` rows with their observed `series_occurrences`.
 *
 * flow_type (engine/flow.ts) is the authority on direction: income rows form
 * inflow series (payroll), expense/interest_fee rows form outflow series
 * (bills, subscriptions); transfers, debt payments and refunds never form
 * series. Rows not yet classified (flow_type NULL) fall back to their sign.
 *
 * Idempotent: re-running updates series in place (keyed on user + core name +
 * direction) and INSERT OR IGNOREs already-recorded occurrences. Previously
 * active series that no longer show up and whose last occurrence is more than
 * two periods stale are marked `paused` (keeps forecasts honest without
 * deleting history).
 */
export async function detectAndPersistSeries(
  db: Sql,
  userId: string,
  lookbackDays = 730,
): Promise<SeriesSyncResult> {
  await applySeriesSchema(db);

  const latest = await db.get<{ d: string }>(
    `SELECT MAX(date) AS d FROM transactions WHERE user_id = ?`, userId,
  );
  const maxDate = latest?.d || null;
  if (!maxDate) return { seriesUpserted: 0, occurrencesRecorded: 0, seriesPaused: 0, series: [] };
  const cutoff = addDays(maxDate, -lookbackDays);

  const txns = await db.all(`SELECT t.id, t.name, t.amount, t.date, t.flow_type, t.category_id,
              c.name AS category_name, c.icon AS category_icon, c.color AS category_color
       FROM transactions t
       LEFT JOIN categories c ON t.category_id = c.id
       WHERE t.user_id = ? AND t.date >= ?
         AND (t.flow_type IN ('income', 'expense', 'interest_fee') OR t.flow_type IS NULL)
       ORDER BY t.date ASC`, userId, cutoff) as TxnRow[];

  const inflows: TxnRow[] = [];
  const outflows: TxnRow[] = [];
  for (const t of txns) {
    if (t.flow_type === 'income') inflows.push(t);
    else if (t.flow_type === 'expense' || t.flow_type === 'interest_fee') outflows.push(t);
    else if (t.amount > 0) inflows.push(t);       // unclassified fallback only
    else if (t.amount < 0) outflows.push(t);
  }

  const detected: Array<{ direction: 'inflow' | 'outflow'; candidate: RecurringCandidate }> = [];
  for (const c of detectRecurring(inflows)) detected.push({ direction: 'inflow', candidate: c });
  for (const c of detectRecurring(outflows)) detected.push({ direction: 'outflow', candidate: c });

  const now = new Date().toISOString();
  let occurrencesRecorded = 0;
  const activeIds = new Set<string>();

  await db.tx(async (t) => {
    for (const { direction, candidate } of detected) {
      const firstSeen = candidate.matchedTransactions[0]?.date ?? candidate.latestDate;
      const existing = await t.get<{ id: string }>(
        `SELECT id FROM recurring_series WHERE user_id = ? AND core_name = ? AND direction = ?`,
        userId, candidate.coreName, direction,
      );
      let seriesId: string;
      if (existing) {
        seriesId = existing.id;
        await t.run(
          `UPDATE recurring_series
              SET display_name = ?, cadence = ?, anchor_date = ?, dom_pattern = ?,
                  amount_median = ?, amount_mad = ?, amount_dispersion = ?,
                  first_seen = ?, last_seen = ?, occurrences = ?, confidence = ?,
                  status = CASE WHEN status IN ('active', 'paused') THEN 'active' ELSE status END,
                  category_id = COALESCE(?, category_id), updated_at = ?
            WHERE id = ?`,
          candidate.name, candidate.frequency, candidate.latestDate,
          candidate.domPattern ? JSON.stringify(candidate.domPattern) : null,
          candidate.amount, candidate.amountMad, candidate.amountDispersion,
          firstSeen, candidate.latestDate, candidate.occurrences, candidate.confidence,
          candidate.category_id, now, seriesId,
        );
      } else {
        seriesId = crypto.randomUUID();
        await t.run(
          `INSERT INTO recurring_series
             (id, user_id, core_name, display_name, direction, cadence, anchor_date, dom_pattern,
              amount_median, amount_mad, amount_dispersion, first_seen, last_seen,
              occurrences, confidence, status, category_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
          seriesId, userId, candidate.coreName, candidate.name, direction,
          candidate.frequency, candidate.latestDate,
          candidate.domPattern ? JSON.stringify(candidate.domPattern) : null,
          candidate.amount, candidate.amountMad, candidate.amountDispersion,
          firstSeen, candidate.latestDate, candidate.occurrences, candidate.confidence,
          candidate.category_id, now, now,
        );
      }
      activeIds.add(seriesId);

      for (const m of candidate.matchedTransactions) {
        if (!m.id) continue;   // detection was fed rows without ids — nothing to link
        const r = await t.run(
          `INSERT OR IGNORE INTO series_occurrences (series_id, transaction_id, date, expected_date, amount)
           VALUES (?, ?, ?, NULL, ?)`,
          seriesId, m.id, m.date, m.amount,
        );
        occurrencesRecorded += r.changes;
      }
    }

    // Pause series that stopped occurring (> 2 periods overdue and not re-detected).
    const stale = await t.all(`SELECT id, cadence, last_seen FROM recurring_series
         WHERE user_id = ? AND status = 'active'`, userId) as Array<{ id: string; cadence: string; last_seen: string }>;
    for (const s of stale) {
      if (activeIds.has(s.id)) continue;
      const overdueAt = addDays(s.last_seen, Math.round(2 * nominalPeriodDays(s.cadence)));
      if (maxDate > overdueAt) {
        await t.run(
          `UPDATE recurring_series SET status = 'paused', updated_at = ? WHERE id = ?`,
          now, s.id,
        );
      }
    }
  });

  const series = await db.all(`SELECT * FROM recurring_series WHERE user_id = ? ORDER BY confidence DESC`, userId) as SeriesRow[];
  const seriesPaused = series.filter((s) => s.status === 'paused').length;

  return { seriesUpserted: detected.length, occurrencesRecorded, seriesPaused, series };
}

// ---------------------------------------------------------------------------
// Queries for insights.ts to adopt
// ---------------------------------------------------------------------------

/**
 * Observed price history per series, derived from actual transactions —
 * the replacement for parsing `recurring_expenses.price_history` (write-only
 * blob, audit D17). Ordered oldest → newest within each series.
 */
export async function getSeriesPriceHistory(
  db: Sql,
  userId: string,
  seriesId?: string,
): Promise<SeriesPriceHistory[]> {
  const seriesRows = seriesId
    ? await db.all(`SELECT * FROM recurring_series WHERE user_id = ? AND id = ?`, userId, seriesId) as SeriesRow[]
    : await db.all(`SELECT * FROM recurring_series WHERE user_id = ? AND status IN ('active', 'paused', 'user_confirmed')
         ORDER BY confidence DESC`, userId) as SeriesRow[];
  if (seriesRows.length === 0) return [];

  const out: SeriesPriceHistory[] = [];
  for (const s of seriesRows) {
    const points = await db.all(`SELECT transaction_id, date, amount FROM series_occurrences
         WHERE series_id = ? ORDER BY date ASC, transaction_id ASC`, s.id) as PricePoint[];
    out.push({
      seriesId: s.id,
      name: s.display_name,
      coreName: s.core_name,
      direction: s.direction,
      cadence: s.cadence,
      points,
    });
  }
  return out;
}

/**
 * Sustained price increases across outflow series, per the v2 spec (§3.2):
 * median of the last 2 occurrences vs the median of all prior occurrences
 * (needs ≥ 3 prior, ≥ 5 total), flagged when the increase exceeds
 * max($0.75, 2%). Comparing medians of the last TWO occurrences means a
 * one-off proration or tax blip does not fire the insight — the increase has
 * to be sustained.
 */
export async function detectPriceHikes(db: Sql, userId: string): Promise<PriceHike[]> {
  const histories = await getSeriesPriceHistory(db, userId);
  const hikes: PriceHike[] = [];

  for (const h of histories) {
    if (h.direction !== 'outflow') continue;
    if (h.points.length < 5) continue;
    const amounts = h.points.map((p) => Math.abs(p.amount));
    const recent = amounts.slice(-2);
    const baseline = amounts.slice(0, -2);
    const newAmount = median(recent);
    const oldAmount = median(baseline);
    if (oldAmount <= 0) continue;
    const increase = newAmount - oldAmount;
    if (increase <= Math.max(0.75, 0.02 * oldAmount)) continue;
    hikes.push({
      seriesId: h.seriesId,
      name: h.name,
      cadence: h.cadence,
      oldAmount: round2(oldAmount),
      newAmount: round2(newAmount),
      pctChange: increase / oldAmount,
      annualDelta: round2(increase * occurrencesPerYear(h.cadence)),
    });
  }

  hikes.sort((a, b) => b.annualDelta - a.annualDelta);
  return hikes;
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
