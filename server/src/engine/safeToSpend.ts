/**
 * Safe to Spend v2 (audit item 9 / design spec §1.6).
 *
 * Replaces the client-side `income − spent − upcomingRecurring` formula, which
 * had no idea what the account balance was and went deeply negative before
 * payday. The server-side model is the one Simplifi/Monarch converge on:
 *
 *   safe_to_spend = liquid cash balance
 *                 − committed outflows due before the next expected inflow
 *                 − a volatility buffer
 *
 *   - liquid balance  = current balance across visible checking/savings.
 *   - committed       = detected recurring bills (from transaction history,
 *                       flow_type-aware) plus manually tracked
 *                       recurring_expenses, projected into (today, next pay].
 *   - buffer          = a fixed floor plus a robust quantile spread (q75 −
 *                       median) of historical discretionary spend over windows
 *                       of the same length — no normality assumed, computed
 *                       from empirical sliding-window totals.
 *   - next inflow     = earliest projected occurrence of a detected income
 *                       series (semi-monthly payroll handled explicitly — the
 *                       most common US cadence alternates 13/17-day gaps and
 *                       defeats naive mean-interval classification).
 *
 * All components are returned so the UI can explain the number. Sparse, stale,
 * or new-user data degrades to a clearly-marked low-confidence result instead
 * of a confident wrong number.
 *
 * flow_type (engine/flow.ts) is the authority on income/expense — nothing here
 * infers income from `amount > 0`.
 */
import type { Sql } from '../db/sql.js';
import { recurringCoreName } from './recurring-detector.js';
import { frequencyStep } from './frequency.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type Cadence = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';

export interface IncomeProjection {
  date: string;
  amount: number;
  name: string;
  cadence: Cadence;
  confidence: number;
}

export interface CommittedItem {
  name: string;
  amount: number;
  dueDate: string;
  source: 'detected' | 'manual';
  cadence: string;
}

export interface SafeToSpendResult {
  safeToSpend: number;
  perDay: number;
  daysUntilNextIncome: number;
  asOf: string;
  window: { start: string; end: string; days: number };
  balance: {
    total: number;
    accounts: Array<{ id: string; name: string; type: string; balance: number }>;
  };
  nextIncome: IncomeProjection | null;
  committed: { total: number; items: CommittedItem[] };
  buffer: {
    total: number;
    floor: number;
    volatility: number;
    quantile: number;
    windowDays: number;
    sampleCount: number;
  };
  confidence: 'high' | 'medium' | 'low';
  notes: string[];
}

// ---------------------------------------------------------------------------
// Date helpers — pure string/epoch-day math, no local/UTC mixing (audit D15)
// ---------------------------------------------------------------------------

const DAY_MS = 86400000;

function epochDay(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function fromEpochDay(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysInMonth(year: number, month: number): number {
  // month is 1-based; day 0 of next month = last day of this month
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Next date strictly after `afterIso` that falls on day-of-month `dom` (clamped to month length). */
function nextDomOccurrence(afterIso: string, dom: number): string {
  let [y, m] = afterIso.slice(0, 10).split('-').map(Number);
  for (let i = 0; i < 24; i++) {
    const d = Math.min(dom, daysInMonth(y, m));
    const candidate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    if (candidate > afterIso) return candidate;
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return afterIso;
}

// ---------------------------------------------------------------------------
// Robust statistics
// ---------------------------------------------------------------------------

function quantile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

function median(values: number[]): number {
  return quantile([...values].sort((a, b) => a - b), 0.5);
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Cadence fitting (grid-based, semi-monthly aware)
// ---------------------------------------------------------------------------

interface CadenceFit {
  cadence: Cadence;
  /** Robust interval score — median |gap − P| / P (lower is better). */
  score: number;
  /** Day-of-month pattern for semimonthly/monthly. */
  domPattern: number[];
  intervalDays: number;
}

/**
 * Fit a cadence to a sorted list of epoch days. Semi-monthly is tested via
 * day-of-month bimodality (two DOM modes ~15 days apart) because its gaps
 * alternate ≈13/17 and fail a plain interval test.
 */
export function fitCadence(days: number[], isoDates: string[]): CadenceFit | null {
  if (days.length < 3) return null;
  const gaps: number[] = [];
  for (let i = 1; i < days.length; i++) {
    const g = days[i] - days[i - 1];
    if (g > 0) gaps.push(g);
  }
  if (gaps.length < 2) return null;
  const medGap = median(gaps);

  // Semi-monthly: DOMs cluster into exactly two modes roughly half a month apart.
  if (medGap >= 11 && medGap <= 20) {
    const domCounts = new Map<number, number>();
    for (const iso of isoDates) {
      const dom = Number(iso.slice(8, 10));
      domCounts.set(dom, (domCounts.get(dom) || 0) + 1);
    }
    // Merge DOMs within ±2 days into clusters.
    const doms = [...domCounts.entries()].sort((a, b) => b[1] - a[1]);
    const clusters: Array<{ dom: number; count: number }> = [];
    for (const [dom, count] of doms) {
      const near = clusters.find((c) => Math.abs(c.dom - dom) <= 2 || Math.abs(c.dom - dom) >= 26);
      if (near) near.count += count;
      else clusters.push({ dom, count });
    }
    if (clusters.length === 2) {
      const covered = clusters[0].count + clusters[1].count;
      const spread = Math.abs(clusters[0].dom - clusters[1].dom);
      if (covered >= isoDates.length * 0.8 && spread >= 10 && spread <= 20) {
        const pattern = [clusters[0].dom, clusters[1].dom].sort((a, b) => a - b);
        const devs = gaps.map((g) => Math.abs(g - 15.2));
        return { cadence: 'semimonthly', score: median(devs) / 15.2, domPattern: pattern, intervalDays: 15 };
      }
    }
  }

  // Plain-interval hypotheses, scored against the hypothesized grid.
  const hypotheses: Array<{ cadence: Cadence; period: number }> = [
    { cadence: 'weekly', period: 7 },
    { cadence: 'biweekly', period: 14 },
    { cadence: 'monthly', period: 30.44 },
  ];
  let best: CadenceFit | null = null;
  for (const h of hypotheses) {
    const devs = gaps.map((g) => {
      const k = Math.max(1, Math.round(g / h.period));
      return Math.abs(g - k * h.period) / h.period;
    });
    // Penalize hypotheses whose period is far from the observed median gap so
    // a monthly series is not "fit" as weekly with k=4.
    if (medGap < h.period * 0.6 || medGap > h.period * 1.6) continue;
    const score = median(devs);
    if (score <= 0.16 && (!best || score < best.score)) {
      const domPattern = h.cadence === 'monthly'
        ? [modeDom(isoDates)]
        : [];
      best = { cadence: h.cadence, score, domPattern, intervalDays: Math.round(h.period) };
    }
  }
  return best;
}

function modeDom(isoDates: string[]): number {
  const counts = new Map<number, number>();
  for (const iso of isoDates) {
    const dom = Number(iso.slice(8, 10));
    counts.set(dom, (counts.get(dom) || 0) + 1);
  }
  let bestDom = 1;
  let bestCount = 0;
  for (const [dom, count] of counts) {
    if (count > bestCount) { bestDom = dom; bestCount = count; }
  }
  return bestDom;
}

/** Project the next occurrence of a fitted series strictly after `afterIso`. */
export function projectNext(fit: CadenceFit, lastIso: string, afterIso: string): string {
  if (fit.cadence === 'semimonthly' || fit.cadence === 'monthly') {
    const anchor = lastIso > afterIso ? lastIso : afterIso;
    const candidates = fit.domPattern.map((dom) => nextDomOccurrence(anchor, dom));
    candidates.sort();
    return candidates[0];
  }
  const period = fit.intervalDays;
  let day = epochDay(lastIso);
  const after = epochDay(afterIso);
  while (day <= after) day += period;
  return fromEpochDay(day);
}

// ---------------------------------------------------------------------------
// Series detection over classified transactions
// ---------------------------------------------------------------------------

interface TxnRow {
  name: string;
  amount: number;
  date: string;
  flow_type: string | null;
}

interface DetectedSeries {
  coreName: string;
  name: string;
  fit: CadenceFit;
  medianAmount: number;
  lastDate: string;
  occurrences: number;
  confidence: number;
}

function detectSeries(rows: TxnRow[], minAmount: number): DetectedSeries[] {
  const groups = new Map<string, TxnRow[]>();
  for (const r of rows) {
    const core = recurringCoreName(r.name);
    if (core.length < 3) continue;
    const list = groups.get(core) || [];
    list.push(r);
    groups.set(core, list);
  }

  const out: DetectedSeries[] = [];
  for (const [core, list] of groups) {
    if (list.length < 3) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    const amounts = list.map((r) => Math.abs(r.amount));
    const med = median(amounts);
    if (med < minAmount) continue;
    // Robust amount consistency: median absolute deviation ≤ 20% of median.
    const mad = median(amounts.map((a) => Math.abs(a - med)));
    if (med > 0 && mad / med > 0.2) continue;

    const isoDates = list.map((r) => r.date.slice(0, 10));
    const days = isoDates.map(epochDay);
    const fit = fitCadence(days, isoDates);
    if (!fit) continue;

    // Confidence: timing fit (0–0.4), amount stability (0–0.3), evidence (0–0.3).
    const timing = Math.max(0, 0.4 * (1 - fit.score / 0.16));
    const amountStability = med > 0 ? Math.max(0, 0.3 * (1 - (mad / med) / 0.2)) : 0.3;
    const evidence = Math.min(0.3, 0.1 * (list.length - 2));
    const confidence = round2(Math.min(1, timing + amountStability + evidence));

    let bestName = list[0].name;
    const nameCounts = new Map<string, number>();
    for (const r of list) nameCounts.set(r.name, (nameCounts.get(r.name) || 0) + 1);
    let bestCount = 0;
    for (const [n, c] of nameCounts) if (c > bestCount) { bestName = n; bestCount = c; }

    out.push({
      coreName: core,
      name: bestName,
      fit,
      medianAmount: round2(med),
      lastDate: isoDates[isoDates.length - 1],
      occurrences: list.length,
      confidence,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Manual recurring_expenses projection
// ---------------------------------------------------------------------------

interface ManualRecurringRow {
  name: string;
  amount: number;
  frequency: string;
  next_date: string;
}

/**
 * Roll a manual recurring item's next_date forward until strictly after
 * `afterIso`. Frequency handling comes from engine/frequency.ts — the two
 * tables that used to live here between them didn't know 'annually' or
 * 'semi-monthly', so those items stopped projecting the moment their due date
 * passed and silently dropped out of committed bills.
 */
export function rollForward(nextDate: string, frequency: string, afterIso: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nextDate)) return null;
  let current = nextDate;
  const step = frequencyStep(frequency);
  const months = step?.months;
  const dayStep = step?.days;
  if (!months && !dayStep) return current > afterIso ? current : null;
  for (let i = 0; i < 400 && current <= afterIso; i++) {
    if (dayStep) {
      current = fromEpochDay(epochDay(current) + dayStep);
    } else {
      const dom = Number(current.slice(8, 10));
      let [y, m] = current.split('-').map(Number);
      m += months!;
      while (m > 12) { m -= 12; y += 1; }
      const d = Math.min(dom, daysInMonth(y, m));
      current = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }
  return current > afterIso ? current : null;
}

// ---------------------------------------------------------------------------
// Main computation
// ---------------------------------------------------------------------------

const BUFFER_FLOOR = 100;
const BUFFER_QUANTILE = 0.75;
const FALLBACK_WINDOW_DAYS = 30;
const HISTORY_DAYS = 400;
const DISCRETIONARY_SPAN_DAYS = 180;
const MIN_PAYCHECK_AMOUNT = 200;
const SERIES_CONFIDENCE_GATE = 0.6;
const STALE_AFTER_DAYS = 45;

export async function computeSafeToSpend(sql: Sql, userId: string, asOf?: string): Promise<SafeToSpendResult> {
  const today = asOf && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : todayIso();
  const notes: string[] = [];
  let confidence: 'high' | 'medium' | 'low' = 'high';
  const RANK = { high: 2, medium: 1, low: 0 } as const;
  const degrade = (to: 'medium' | 'low') => {
    if (RANK[to] < RANK[confidence]) confidence = to;
  };

  // 1. Liquid cash balance — checking + savings, visible accounts only.
  const cashAccounts = await sql.all<{ id: string; name: string; type: string; balance: number }>(
    `SELECT id, name, type, balance FROM accounts
     WHERE user_id = ? AND is_hidden = 0 AND type IN ('checking', 'savings')
     ORDER BY balance DESC`,
    userId,
  );
  const liquidBalance = round2(cashAccounts.reduce((sum, a) => sum + (a.balance || 0), 0));
  if (cashAccounts.length === 0) {
    notes.push('No checking or savings accounts found — safe-to-spend has no balance to anchor on.');
    degrade('low');
  }

  // 2. Classified history (flow_type is authoritative; never amount > 0).
  const historyStart = fromEpochDay(epochDay(today) - HISTORY_DAYS);
  const txns = await sql.all<TxnRow>(
    `SELECT name, amount, date, flow_type FROM transactions
     WHERE user_id = ? AND date >= ? AND date <= ?
     ORDER BY date ASC`,
    userId, historyStart, today,
  );
  const lastTxnDate = txns.length > 0 ? txns[txns.length - 1].date.slice(0, 10) : null;
  const firstTxnDate = txns.length > 0 ? txns[0].date.slice(0, 10) : null;
  const historyDays = firstTxnDate && lastTxnDate ? epochDay(lastTxnDate) - epochDay(firstTxnDate) : 0;
  const staleDays = lastTxnDate ? epochDay(today) - epochDay(lastTxnDate) : null;

  if (txns.length === 0) {
    notes.push('No transaction history in the last 13 months — committed bills and the buffer cannot be estimated.');
    degrade('low');
  } else {
    if (historyDays < 60) {
      notes.push(`Only ${historyDays} days of transaction history — estimates are provisional until ~2 months of data exist.`);
      degrade('low');
    } else if (historyDays < 120) {
      degrade('medium');
      notes.push(`Estimates based on ${historyDays} days of history; they sharpen with more data.`);
    }
    if (staleDays !== null && staleDays > STALE_AFTER_DAYS) {
      notes.push(`Latest transaction is ${staleDays} days old — upload recent statements; balances and projections may be out of date.`);
      degrade('low');
    }
  }

  // 3. Next expected inflow — detected income series (paycheck-shaped).
  const incomeRows = txns.filter((t) => t.flow_type === 'income' && t.amount > 0);
  const incomeSeries = detectSeries(incomeRows, MIN_PAYCHECK_AMOUNT)
    .filter((s) => s.confidence >= SERIES_CONFIDENCE_GATE);

  let nextIncome: IncomeProjection | null = null;
  for (const s of incomeSeries) {
    const date = projectNext(s.fit, s.lastDate, today);
    if (!nextIncome || date < nextIncome.date) {
      nextIncome = { date, amount: s.medianAmount, name: s.name, cadence: s.fit.cadence, confidence: s.confidence };
    }
  }

  const windowEnd = nextIncome ? nextIncome.date : fromEpochDay(epochDay(today) + FALLBACK_WINDOW_DAYS);
  const windowDays = Math.max(1, epochDay(windowEnd) - epochDay(today));
  if (!nextIncome) {
    notes.push(`No regular income pattern detected — using a ${FALLBACK_WINDOW_DAYS}-day planning window instead of a payday anchor.`);
    degrade('low');
  }

  // 4. Committed outflows due in (today, windowEnd].
  const committedItems: CommittedItem[] = [];
  const recurringCores = new Set<string>();

  // 4a. Detected recurring bills from history.
  const outflowRows = txns.filter(
    (t) => (t.flow_type === 'expense' || t.flow_type === 'interest_fee') && t.amount < 0,
  );
  const billSeries = detectSeries(outflowRows, 2).filter((s) => s.confidence >= SERIES_CONFIDENCE_GATE);
  for (const s of billSeries) recurringCores.add(s.coreName);

  // 4b. Manually tracked recurring expenses.
  const manualRows = await sql.all<ManualRecurringRow>(
    `SELECT name, amount, frequency, next_date FROM recurring_expenses
     WHERE user_id = ? AND is_active = 1`,
    userId,
  );
  const manualCores = new Set<string>();
  for (const m of manualRows) {
    const core = recurringCoreName(m.name);
    if (core.length >= 3) manualCores.add(core);
    recurringCores.add(core);
    const due = rollForward(m.next_date, m.frequency, today);
    if (due && due <= windowEnd) {
      committedItems.push({
        name: m.name,
        amount: round2(Math.abs(m.amount)),
        dueDate: due,
        source: 'manual',
        cadence: (m.frequency || '').toLowerCase(),
      });
    }
  }

  // Detected series enter committed only when a manual entry doesn't already
  // cover the same merchant (manual entries win — the user typed them).
  for (const s of billSeries) {
    const coveredByManual = [...manualCores].some(
      (core) => core === s.coreName || core.includes(s.coreName) || s.coreName.includes(core),
    );
    if (coveredByManual) continue;
    const due = projectNext(s.fit, s.lastDate, today);
    if (due <= windowEnd) {
      committedItems.push({
        name: s.name,
        amount: s.medianAmount,
        dueDate: due,
        source: 'detected',
        cadence: s.fit.cadence,
      });
    }
  }
  committedItems.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || b.amount - a.amount);
  const committedTotal = round2(committedItems.reduce((sum, c) => sum + c.amount, 0));

  // 5. Buffer — floor + robust spread (q75 − median) of historical
  // discretionary spend over sliding windows of the same length. Discretionary
  // = expense/interest_fee outflows NOT matched to any recurring series.
  const spanEnd = lastTxnDate && lastTxnDate < today ? lastTxnDate : today;
  const spanStart = fromEpochDay(epochDay(spanEnd) - DISCRETIONARY_SPAN_DAYS + 1);
  const daily = new Map<number, number>();
  for (const t of outflowRows) {
    const iso = t.date.slice(0, 10);
    if (iso < spanStart || iso > spanEnd) continue;
    const core = recurringCoreName(t.name);
    if (recurringCores.has(core)) continue;
    const day = epochDay(iso);
    daily.set(day, (daily.get(day) || 0) + Math.abs(t.amount));
  }

  const coveredDays = firstTxnDate
    ? Math.min(DISCRETIONARY_SPAN_DAYS, epochDay(spanEnd) - Math.max(epochDay(spanStart), epochDay(firstTxnDate)) + 1)
    : 0;
  let volatility = 0;
  let sampleCount = 0;
  if (coveredDays >= windowDays + 14) {
    const startDay = epochDay(spanEnd) - coveredDays + 1;
    const series: number[] = [];
    for (let d = startDay; d <= epochDay(spanEnd); d++) series.push(daily.get(d) || 0);
    // Sliding-window totals of length `windowDays`.
    const totals: number[] = [];
    let rolling = 0;
    for (let i = 0; i < series.length; i++) {
      rolling += series[i];
      if (i >= windowDays) rolling -= series[i - windowDays];
      if (i >= windowDays - 1) totals.push(round2(rolling));
    }
    sampleCount = totals.length;
    const sorted = [...totals].sort((a, b) => a - b);
    volatility = round2(Math.max(0, quantile(sorted, BUFFER_QUANTILE) - quantile(sorted, 0.5)));
  } else {
    notes.push('Not enough discretionary-spend history to size the volatility buffer — using the floor only.');
    degrade('medium');
  }
  const bufferTotal = round2(BUFFER_FLOOR + volatility);

  // 6. The number.
  const safeToSpend = round2(liquidBalance - committedTotal - bufferTotal);
  const perDay = round2(Math.max(0, safeToSpend) / windowDays);

  return {
    safeToSpend,
    perDay,
    daysUntilNextIncome: windowDays,
    asOf: today,
    window: { start: today, end: windowEnd, days: windowDays },
    balance: {
      total: liquidBalance,
      accounts: cashAccounts.map((a) => ({ id: a.id, name: a.name, type: a.type, balance: round2(a.balance || 0) })),
    },
    nextIncome,
    committed: { total: committedTotal, items: committedItems },
    buffer: {
      total: bufferTotal,
      floor: BUFFER_FLOOR,
      volatility,
      quantile: BUFFER_QUANTILE,
      windowDays,
      sampleCount,
    },
    confidence,
    notes,
  };
}
