// ---------------------------------------------------------------------------
// Recurring Transaction Detector
// ---------------------------------------------------------------------------
// Analyzes transaction history to find TRUE recurring charges:
//   1. Same merchant (core name match)
//   2. A stable amount MODEL (median + MAD) — variable bills (utilities) are
//      kept, with their dispersion recorded, instead of being rejected
//   3. A cadence that FITS A GRID: weekly, biweekly, semi-monthly (day-of-month
//      pair, e.g. 1st & 15th payroll), monthly (day-of-month), quarterly,
//      semi-annual, annual
//
// Why grid fitting instead of mean-gap classification (the old approach):
//   - A 1st-and-15th payroll has alternating ~14/17-day gaps that AVERAGE to
//     ~15.2 days, which fits neither "biweekly" nor "monthly" — the single most
//     common US pay schedule was invisible.
//   - A single skipped occurrence corrupts the mean gap (one 60-day gap in a
//     monthly series) and used to destroy detection. Scoring each observation
//     against the hypothesized grid means a missed occurrence just leaves a
//     hole in the grid — the offsets of every other observation are untouched.
//   - Bursty merchants (5 coffee runs in a week) average to "weekly"; the grid
//     fit requires observations to land on DISTINCT grid slots.
//
// Confidence scales with the number of observed occurrences: two points define
// any interval, so two occurrences are returned (if at all) as weak candidates,
// never as strong series.
// ---------------------------------------------------------------------------

import { epochDay, fromEpochDay, dayOfMonth, yearMonth, gridDayInMonth, monthKey } from '../lib/dates.js';
import { median, mad } from '../lib/stats.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RecurringCandidate {
  name: string;              // most common original transaction name
  coreName: string;          // normalized name for grouping
  amount: number;            // median amount
  frequency: RecurringFrequency;
  confidence: number;        // 0–1 how confident we are this is recurring
  monthCount: number;        // distinct months seen
  occurrences: number;       // total transaction count
  category_id: string | null;
  category_name: string | null;
  category_icon: string | null;
  category_color: string | null;
  latestDate: string;
  avgIntervalDays: number;   // nominal period of the fitted cadence
  // --- fields added by the grid-fit upgrade (additive; existing callers unaffected)
  amountMad: number;         // robust dispersion of the amount (MAD)
  amountDispersion: number;  // MAD / median — 0 for fixed-price, ~0.2+ for variable bills
  fitScore: number;          // median |grid offset| / period (lower = tighter fit)
  domPattern?: number[];     // day(s)-of-month for monthly ([15]) / semi-monthly ([1,15])
  matchedTransactions: Array<{ id?: string; date: string; amount: number }>;
}

export type RecurringFrequency =
  | 'weekly'
  | 'biweekly'
  | 'semi-monthly'
  | 'monthly'
  | 'quarterly'
  | 'semi-annual'
  | 'annual'
  | 'irregular';

interface TransactionRow {
  id?: string;               // optional — when present, flows into matchedTransactions
  name: string;
  amount: number;
  date: string;
  category_id: string | null;
  category_name: string | null;
  category_icon: string | null;
  category_color: string | null;
}

// ---------------------------------------------------------------------------
// Core name extraction — same logic as duplicates.ts but exported here
// ---------------------------------------------------------------------------

export function recurringCoreName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[#\-_:\/\\*]+/g, ' ')
    .replace(/\b\d{4,}\b/g, '')          // drop long numbers (store IDs, refs, phone #s)
    .replace(/\d+\.\d+/g, '')            // drop decimal numbers
    .replace(/\b(pos|debit|visa|mastercard|check|crd|purchase|credit|card|recurring|autopay|online|pmt|pymt|bill)\b/g, '')
    .replace(/\b[a-z]{2}\b/g, '')        // drop 2-letter state codes
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Cadence fitting
// ---------------------------------------------------------------------------

export interface CadenceFit {
  frequency: Exclude<RecurringFrequency, 'irregular'>;
  periodDays: number;        // nominal period
  offsetMedianDays: number;  // median |observation − nearest grid point|
  score: number;             // offsetMedianDays / periodDays
  domPattern?: number[];
  slotsSpanned: number;      // grid points between first and last observation
  slotsMatched: number;      // distinct grid points actually hit
}

const INTERVAL_CADENCES: Array<{ frequency: CadenceFit['frequency']; period: number }> = [
  { frequency: 'weekly', period: 7 },
  { frequency: 'biweekly', period: 14 },
  { frequency: 'monthly', period: 30.44 },
  { frequency: 'quarterly', period: 91.31 },
  { frequency: 'semi-annual', period: 182.62 },
  { frequency: 'annual', period: 365.25 },
];

/** Specificity used only to break near-ties (calendar-aware fits preferred). */
const TIE_ORDER: Record<string, number> = {
  'semi-monthly': 0, weekly: 1, biweekly: 2, monthly: 3,
  quarterly: 4, 'semi-annual': 5, annual: 6,
};

/** Signed x mod p, mapped into [-p/2, p/2). */
function signedMod(x: number, p: number): number {
  let r = x % p;
  if (r < -p / 2) r += p;
  if (r >= p / 2) r -= p;
  return r;
}

function fitInterval(days: number[], frequency: CadenceFit['frequency'], period: number): CadenceFit | null {
  const a = days[0];
  // First pass: raw circular offsets against a grid anchored on the first
  // observation; the median offset re-centers the anchor (least-absolute fit).
  const shift = median(days.map((d) => signedMod(d - a, period)));
  const anchor = a + shift;
  const offsets: number[] = [];
  const slots = new Set<number>();
  let minK = Infinity;
  let maxK = -Infinity;
  for (const d of days) {
    const k = Math.round((d - anchor) / period);
    offsets.push(Math.abs(d - (anchor + k * period)));
    slots.add(k);
    if (k < minK) minK = k;
    if (k > maxK) maxK = k;
  }
  const offsetMedianDays = median(offsets);
  const slotsSpanned = maxK - minK + 1;
  const slotsMatched = slots.size;

  // Acceptance: tight median offset (skip-tolerant — a missed occurrence is a
  // hole in the grid, not a corrupted offset), observations on DISTINCT slots
  // (rejects bursty merchants), and most of the grid occupied (rejects random
  // dates near a sparse fine-grained grid, and stops an exact biweekly series
  // from also "fitting" a half-empty weekly grid).
  if (offsetMedianDays > Math.max(1.5, 0.1 * period)) return null;
  if (slotsMatched < Math.ceil(days.length * 0.75)) return null;
  if (slotsMatched / slotsSpanned < 0.6) return null;
  if (slotsMatched < 2) return null;

  return {
    frequency, periodDays: period, offsetMedianDays,
    score: offsetMedianDays / period, slotsSpanned, slotsMatched,
  };
}

/** All months (year, month) touched between two epoch days, inclusive. */
function monthsInSpan(firstDay: number, lastDay: number): Array<{ year: number; month: number }> {
  const out: Array<{ year: number; month: number }> = [];
  let { year, month } = yearMonth(fromEpochDay(firstDay));
  const end = yearMonth(fromEpochDay(lastDay));
  while (year < end.year || (year === end.year && month <= end.month)) {
    out.push({ year, month });
    month++;
    if (month > 12) { month = 1; year++; }
  }
  return out;
}

/** Score observations against an explicit list of grid days. */
function scoreAgainstGrid(days: number[], grid: number[]): {
  offsetMedianDays: number; slotsMatched: number; matchedIdx: number[];
} {
  const offsets: number[] = [];
  const matchedIdx: number[] = [];
  const slots = new Set<number>();
  for (const d of days) {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < grid.length; i++) {
      const dist = Math.abs(d - grid[i]);
      if (dist < bestDist) { bestDist = dist; best = i; }
    }
    offsets.push(bestDist);
    matchedIdx.push(best);
    slots.add(best);
  }
  return { offsetMedianDays: median(offsets), slotsMatched: slots.size, matchedIdx };
}

/** Monthly on a specific day-of-month (business-day shifts tolerated ±4). */
function fitMonthlyDom(days: number[], doms: number[]): CadenceFit | null {
  const months = monthsInSpan(days[0], days[days.length - 1]);
  if (months.length < 2) return null;
  let best: CadenceFit | null = null;
  for (const dom of new Set(doms)) {
    const grid = months.map((m) => gridDayInMonth(m.year, m.month, dom));
    const { offsetMedianDays, slotsMatched } = scoreAgainstGrid(days, grid);
    if (offsetMedianDays > 4) continue;
    if (slotsMatched < Math.ceil(days.length * 0.75)) continue;
    if (slotsMatched / months.length < 0.5) continue;
    const fit: CadenceFit = {
      frequency: 'monthly', periodDays: 30.44, offsetMedianDays,
      score: offsetMedianDays / 30.44, domPattern: [dom],
      slotsSpanned: months.length, slotsMatched,
    };
    if (!best || fit.score < best.score) best = fit;
  }
  return best;
}

/**
 * Semi-monthly: two anchor days-of-month ~half a month apart (1st & 15th,
 * 15th & 30th, …). Alternating ~14/17-day gaps mean NO single interval fits —
 * this is the payroll fix. Requires both halves of the pattern to be observed.
 */
function fitSemiMonthly(days: number[], doms: number[]): CadenceFit | null {
  if (days.length < 4) return null;
  const months = monthsInSpan(days[0], days[days.length - 1]);
  if (months.length < 2) return null;
  const distinct = [...new Set(doms)].sort((a, b) => a - b);
  let best: CadenceFit | null = null;
  for (let i = 0; i < distinct.length; i++) {
    for (let j = i + 1; j < distinct.length; j++) {
      const d1 = distinct[i];
      const d2 = distinct[j];
      const gap = d2 - d1;
      if (gap < 10 || gap > 20) continue;  // the complement (~30 − gap) is then also 10–20
      const grid: number[] = [];
      for (const m of months) {
        grid.push(gridDayInMonth(m.year, m.month, d1));
        grid.push(gridDayInMonth(m.year, m.month, d2));
      }
      const { offsetMedianDays, slotsMatched, matchedIdx } = scoreAgainstGrid(days, grid);
      if (offsetMedianDays > 3) continue;
      if (slotsMatched < Math.ceil(days.length * 0.75)) continue;
      if (slotsMatched / grid.length < 0.5) continue;
      // Both sub-grids must be used, otherwise this is just monthly.
      const firstHalf = matchedIdx.filter((k) => k % 2 === 0).length;
      const secondHalf = matchedIdx.length - firstHalf;
      if (firstHalf < 2 || secondHalf < 2) continue;
      const fit: CadenceFit = {
        frequency: 'semi-monthly', periodDays: 15.22, offsetMedianDays,
        score: offsetMedianDays / 15.22, domPattern: [d1, d2],
        slotsSpanned: grid.length, slotsMatched,
      };
      if (!best || fit.score < best.score) best = fit;
    }
  }
  return best;
}

/**
 * Fit the best cadence for a sorted list of dates (epoch days).
 * Returns null when nothing fits — the series is irregular.
 */
export function fitCadence(days: number[]): CadenceFit | null {
  if (days.length < 2) return null;
  const doms = days.map((d) => dayOfMonth(fromEpochDay(d)));

  const fits: CadenceFit[] = [];
  for (const c of INTERVAL_CADENCES) {
    // Skip periods longer than ~1.5× the observed span — unfittable.
    if (c.period > (days[days.length - 1] - days[0]) * 1.5 + 1) continue;
    const f = fitInterval(days, c.frequency, c.period);
    if (f) fits.push(f);
  }
  const domFit = fitMonthlyDom(days, doms);
  if (domFit) fits.push(domFit);
  const semi = fitSemiMonthly(days, doms);
  if (semi) fits.push(semi);

  if (fits.length === 0) return null;
  fits.sort((a, b) => {
    if (Math.abs(a.score - b.score) > 0.015) return a.score - b.score;
    return TIE_ORDER[a.frequency] - TIE_ORDER[b.frequency];
  });
  return fits[0];
}

// ---------------------------------------------------------------------------
// Main detection function
// ---------------------------------------------------------------------------

export function detectRecurring(transactions: TransactionRow[]): RecurringCandidate[] {
  // 1. Group transactions by core name
  const groups = new Map<string, {
    names: Map<string, number>;
    entries: Array<{ id?: string; amount: number; date: string }>;
    category_id: string | null;
    category_name: string | null;
    category_icon: string | null;
    category_color: string | null;
  }>();

  for (const tx of transactions) {
    const core = recurringCoreName(tx.name);
    if (core.length < 3) continue;

    if (!groups.has(core)) {
      groups.set(core, {
        names: new Map(),
        entries: [],
        category_id: tx.category_id,
        category_name: tx.category_name,
        category_icon: tx.category_icon,
        category_color: tx.category_color,
      });
    }

    const g = groups.get(core)!;
    g.entries.push({ id: tx.id, amount: Math.abs(tx.amount), date: tx.date });
    g.names.set(tx.name, (g.names.get(tx.name) || 0) + 1);
    if (tx.category_id && !g.category_id) {
      g.category_id = tx.category_id;
      g.category_name = tx.category_name;
      g.category_icon = tx.category_icon;
      g.category_color = tx.category_color;
    }
  }

  // 2. Analyze each group
  const candidates: RecurringCandidate[] = [];

  for (const [core, g] of groups) {
    // Need at least 2 occurrences to detect a pattern
    if (g.entries.length < 2) continue;

    // Sort entries by date ascending
    g.entries.sort((a, b) => a.date.localeCompare(b.date));

    // --- Amount model: median + MAD ---
    // Variable-amount bills (utilities swinging 40% month to month) are kept
    // and modeled at their median with the dispersion recorded — the old hard
    // 15% variance gate rejected exactly the bills users most want tracked.
    const amounts = g.entries.map((e) => e.amount);
    const medianAmount = median(amounts);
    if (medianAmount <= 0) continue;
    const amountMad = mad(amounts, medianAmount);
    const amountDispersion = amountMad / medianAmount;

    // Only reject truly formless amounts (dispersion > 50% of the median):
    // that is variable shopping, not a bill.
    if (amountDispersion > 0.5) continue;

    // --- Cadence fit ---
    const days = g.entries.map((e) => epochDay(e.date)).filter((d) => !Number.isNaN(d));
    if (days.length < 2) continue;
    const fit = fitCadence(days);
    if (!fit) continue;  // irregular — not recurring

    // --- Confidence ---
    // conf = 0.30·amount-tightness + 0.35·grid-fit-tightness
    //      + 0.20·occurrence-count  + 0.15·grid-coverage
    // then scaled down hard for tiny samples: two points define ANY interval,
    // so n=2 can never look strong (was reachable at ~0.79 before).
    const amountScore =
      amountDispersion <= 0.01 ? 1 :
      amountDispersion <= 0.05 ? 0.9 :
      amountDispersion <= 0.15 ? 0.75 :
      amountDispersion <= 0.30 ? 0.55 : 0.35;

    const fitScore01 =
      fit.score <= 0.02 ? 1 :
      fit.score <= 0.05 ? 0.9 :
      fit.score <= 0.10 ? 0.75 : 0.5;

    const occurrences = g.entries.length;
    const nScore =
      occurrences >= 8 ? 1 :
      occurrences >= 6 ? 0.9 :
      occurrences === 5 ? 0.8 :
      occurrences === 4 ? 0.6 :
      occurrences === 3 ? 0.4 : 0;

    const coverage = fit.slotsMatched / fit.slotsSpanned;

    const smallSampleFactor = occurrences <= 2 ? 0.55 : occurrences === 3 ? 0.8 : 1;

    const confidence =
      (0.30 * amountScore + 0.35 * fitScore01 + 0.20 * nScore + 0.15 * coverage) *
      smallSampleFactor;

    // Only include candidates with reasonable confidence
    if (confidence < 0.40) continue;

    // Pick most common original name
    let bestName = '';
    let bestCount = 0;
    for (const [n, count] of g.names) {
      if (count > bestCount) { bestName = n; bestCount = count; }
    }

    const latestDate = g.entries[g.entries.length - 1].date;
    const distinctMonths = new Set(g.entries.map((e) => monthKey(e.date))).size;

    candidates.push({
      name: bestName,
      coreName: core,
      amount: round2(medianAmount),
      frequency: fit.frequency,
      confidence: round2(confidence),
      monthCount: distinctMonths,
      occurrences,
      category_id: g.category_id,
      category_name: g.category_name,
      category_icon: g.category_icon,
      category_color: g.category_color,
      latestDate,
      avgIntervalDays: Math.round(fit.periodDays),
      amountMad: round2(amountMad),
      amountDispersion: round2(amountDispersion),
      fitScore: round2(fit.score),
      domPattern: fit.domPattern,
      matchedTransactions: g.entries.map((e) => ({ id: e.id, date: e.date, amount: e.amount })),
    });
  }

  // Sort by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence);

  return candidates;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
