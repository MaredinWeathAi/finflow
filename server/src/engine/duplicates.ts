import { db } from '../db/database.js';
import { addDays, daysApart } from '../lib/dates.js';
import { median } from '../lib/stats.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DuplicateMatch {
  itemId: string;
  matchedTransactionId: string;
  score: number;
  reasons: string[];
  matchType: 'existing' | 'cross_file';
}

export interface PendingItemData {
  id: string;
  parsed_name: string;
  parsed_amount: number;
  parsed_date: string;
  parsed_category?: string;
  matched_category_id?: string;
  file_id: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// A true duplicate MUST score >= 70.  Items marked as duplicates at upload
// time use this threshold (see upload.ts line ~366).
const MATCH_THRESHOLD = 70;

// Only look at existing transactions within ±3 days of the uploaded item.
// Real duplicates come from overlapping statements — 3 days handles posting
// lag without false-flagging a recurring monthly charge.
const DATE_WINDOW_DAYS = 3;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'payment', 'purchase', 'to', 'for', 'and', 'in',
  'at', 'on', 'by', 'from', 'with',
]);

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

/**
 * Find duplicates between uploaded items and EXISTING transactions in the DB.
 */
export async function findDuplicates(
  items: PendingItemData[],
  userId: string,
): Promise<DuplicateMatch[]> {
  const matches: DuplicateMatch[] = [];
  const habitualCores = await getHabitualMerchantCores(items, userId);

  for (const item of items) {
    // Date window edges via pure calendar math — the old `new Date(str)` +
    // setDate mix parsed as UTC but shifted in local time, moving the window
    // by a day near midnight on any server west of UTC.
    const minDate = addDays(item.parsed_date, -DATE_WINDOW_DAYS);
    const maxDate = addDays(item.parsed_date, DATE_WINDOW_DAYS);

    const rows = await db.all(`SELECT id, name, amount, date, category_id
         FROM transactions
         WHERE user_id = ? AND date >= ? AND date <= ?`, userId, minDate, maxDate) as {
      id: string;
      name: string;
      amount: number;
      date: string;
      category_id: string | null;
    }[];

    const itemCore = coreOf(item.parsed_name);

    for (const row of rows) {
      const result = scorePair(
        {
          name: item.parsed_name,
          amount: item.parsed_amount,
          date: item.parsed_date,
        },
        {
          name: row.name,
          amount: row.amount,
          date: row.date,
        },
        { habitualMerchant: habitualCores.has(itemCore) && habitualCores.has(coreOf(row.name)) },
      );

      if (result.score >= MATCH_THRESHOLD) {
        matches.push({
          itemId: item.id,
          matchedTransactionId: row.id,
          score: result.score,
          reasons: result.reasons,
          matchType: 'existing',
        });
      }
    }
  }

  return matches;
}

/**
 * Find duplicates BETWEEN uploaded files (cross-file overlaps).
 * Only compares items from different files.
 */
export function findCrossFileOverlaps(
  items: PendingItemData[],
): DuplicateMatch[] {
  const matches: DuplicateMatch[] = [];

  // Habitual-cadence merchants inferred from the upload batch itself (per
  // file, so an overlapping statement pair doesn't double-count the same
  // visits): frequent, spread-out visits mean different-day matches are the
  // user's routine, not statement overlap.
  const datesByCore = new Map<string, Set<string>>();
  for (const it of items) {
    const core = coreOf(it.parsed_name);
    if (core.length < 3) continue;
    const key = `${it.file_id}\u0000${core}`;
    const set = datesByCore.get(key) || new Set<string>();
    set.add(String(it.parsed_date).slice(0, 10));
    datesByCore.set(key, set);
  }
  const habitualCores = new Set<string>();
  for (const [key, dates] of datesByCore) {
    if (isHabitualCadence([...dates])) habitualCores.add(key.split('\u0000')[1]);
  }

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];

      // Only compare items from DIFFERENT files
      if (a.file_id === b.file_id) continue;

      const result = scorePair(
        {
          name: a.parsed_name,
          amount: a.parsed_amount,
          date: a.parsed_date,
        },
        {
          name: b.parsed_name,
          amount: b.parsed_amount,
          date: b.parsed_date,
        },
        { habitualMerchant: habitualCores.has(coreOf(a.parsed_name)) && habitualCores.has(coreOf(b.parsed_name)) },
      );

      if (result.score >= MATCH_THRESHOLD) {
        matches.push({
          itemId: a.id,
          matchedTransactionId: b.id,
          score: result.score,
          reasons: result.reasons,
          matchType: 'cross_file',
        });
      }
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Scoring — A REAL duplicate must match on ALL THREE: amount, date, and name
// ---------------------------------------------------------------------------
//
// Philosophy: A duplicate is the SAME transaction appearing twice — typically
// from overlapping bank statement exports.  Two charges for $12.50 at
// different merchants on the same day are NOT duplicates.
//
// Scoring breakdown (100 max):
//   Amount:  40 pts — exact match required for high confidence
//   Name:    35 pts — must be the same or very similar merchant
//   Date:    25 pts — same day or within posting lag (1-3 days)
//
// The 70-point threshold means you effectively need:
//   - Exact amount (40) + exact/similar name (25-35) = 65-75  ✅ duplicate
//   - Exact amount (40) + exact date (25) + no name match = 65 ❌ not enough
//   - Different amount + same name + same date = 60 max      ❌ not enough
//
// This prevents false positives from coincidental same-amount-same-day charges.

interface Scorable {
  name: string;
  amount: number;
  date: string;
}

export interface ScorePairOptions {
  /**
   * Both sides belong to a merchant the user visits on an established repeat
   * cadence (see isHabitualCadence). Different-day matches at such merchants
   * are the user's routine — two identical coffees three days apart — not
   * statement overlap, so they are heavily discounted. Same-day matches are
   * NOT discounted: a genuine double charge is same-day.
   */
  habitualMerchant?: boolean;
}

export function scorePair(
  item: Scorable,
  existing: Scorable,
  opts?: ScorePairOptions,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // --- Amount (40 pts max) ---
  // Exact penny match is the strongest signal. Small rounding differences
  // (e.g. $12.99 vs $13.00) get partial credit.
  if (item.amount === existing.amount) {
    score += 40;
    reasons.push(`Exact amount match ($${item.amount.toFixed(2)})`);
  } else {
    const amtDiff = existing.amount === 0
      ? (item.amount === 0 ? 0 : 1)
      : Math.abs(item.amount - existing.amount) / Math.abs(existing.amount);

    if (amtDiff <= 0.005) {
      // Within half a percent — likely rounding
      score += 35;
      reasons.push('Near-exact amount (rounding difference)');
    }
    // Anything more than 0.5% off gets ZERO amount points.
    // Two different charges for similar but not identical amounts are not dupes.
  }

  // --- Name similarity (35 pts max) ---
  // This is the critical differentiator. "$12.50 at Starbucks" and "$12.50 at
  // Subway" on the same day must NOT be flagged.
  const nameA = normalizeForComparison(item.name);
  const nameB = normalizeForComparison(existing.name);

  if (nameA === nameB) {
    score += 35;
    reasons.push('Exact name match');
  } else if (nameA.includes(nameB) || nameB.includes(nameA)) {
    // One name contains the other — common with statement truncation
    // e.g. "STARBUCKS #12345 MIAMI" vs "STARBUCKS #12345"
    score += 30;
    reasons.push('Name contained within the other');
  } else {
    // Try core-name extraction (strip numbers/refs)
    const coreA = extractCoreName(nameA);
    const coreB = extractCoreName(nameB);

    if (coreA.length > 2 && coreB.length > 2 && coreA === coreB) {
      score += 28;
      reasons.push('Same merchant (different reference numbers)');
    } else if (coreA.length > 2 && coreB.length > 2 && (coreA.includes(coreB) || coreB.includes(coreA))) {
      score += 25;
      reasons.push('Similar merchant name');
    } else {
      // Levenshtein similarity on core names
      const sim = levenshteinSimilarity(coreA, coreB);
      if (sim > 0.85) {
        score += 22;
        reasons.push('Very similar merchant name');
      } else if (sim > 0.7) {
        score += 15;
        reasons.push('Somewhat similar name');
      } else {
        // Check shared significant words
        const wordRatio = getSharedWordRatio(nameA, nameB);
        if (wordRatio > 0.6) {
          score += 10;
          reasons.push('Shared keywords');
        }
        // Otherwise: 0 name points — names are too different
      }
    }
  }

  // --- Date proximity (25 pts max) ---
  // Same-day is weighted FAR above same-week: an actual duplicate posting is
  // overwhelmingly same-day; each day of gap makes "two separate purchases"
  // more likely than "one transaction posted twice".
  const gap = daysBetween(item.date, existing.date);

  if (gap === 0) {
    score += 25;
    reasons.push('Same date');
  } else if (gap === 1) {
    // Common: transaction posts next business day
    score += 18;
    reasons.push('Dates 1 day apart (posting lag)');
  } else if (gap <= 3) {
    // Weekend/holiday posting delay
    score += 8;
    reasons.push(`Dates ${gap} days apart`);
  }
  // Beyond 3 days: 0 date points (already filtered by DATE_WINDOW_DAYS but
  // cross-file overlaps don't use the SQL filter)

  // --- Habitual-merchant exemption ---
  // At a merchant with an established repeat cadence, a different-day match
  // is almost certainly two routine purchases (daily parking, twice-weekly
  // coffee), so it is pushed below the 70-point threshold. A same-day match
  // keeps its full score — that is what a real double charge looks like.
  if (opts?.habitualMerchant && gap >= 1) {
    score -= 30;
    if (score < 0) score = 0;
    reasons.push('Habitual purchase cadence at this merchant — different-day match discounted');
  }

  return { score, reasons };
}

// ---------------------------------------------------------------------------
// Habitual-cadence detection
// ---------------------------------------------------------------------------

/**
 * Does this list of transaction dates show an established repeat cadence?
 * True when the merchant has been visited at least 4 distinct days with a
 * median gap of ≤ 10 days across a span of at least 2 weeks — daily parking,
 * a twice-weekly coffee, a lunch spot. Such merchants produce identical
 * amounts a few days apart as a matter of ROUTINE, which is exactly the
 * false-positive class the old scorer flagged as duplicates.
 */
export function isHabitualCadence(dates: string[]): boolean {
  const distinct = [...new Set(dates.map((d) => String(d).slice(0, 10)))].sort();
  if (distinct.length < 4) return false;
  const gaps: number[] = [];
  for (let i = 1; i < distinct.length; i++) {
    gaps.push(daysApart(distinct[i - 1], distinct[i]));
  }
  const span = daysApart(distinct[0], distinct[distinct.length - 1]);
  return span >= 14 && median(gaps) <= 10;
}

/**
 * Core names of merchants where the user's EXISTING history shows a habitual
 * cadence, looking back 180 days before the earliest uploaded item.
 */
async function getHabitualMerchantCores(
  items: PendingItemData[],
  userId: string,
): Promise<Set<string>> {
  const habitual = new Set<string>();
  if (items.length === 0) return habitual;

  let minDate = String(items[0].parsed_date).slice(0, 10);
  for (const it of items) {
    const d = String(it.parsed_date).slice(0, 10);
    if (d < minDate) minDate = d;
  }
  const cutoff = addDays(minDate, -180);

  const rows = await db.all(`SELECT name, date FROM transactions
       WHERE user_id = ? AND date >= ?`, userId, cutoff) as { name: string; date: string }[];

  const datesByCore = new Map<string, string[]>();
  for (const r of rows) {
    const core = coreOf(r.name);
    if (core.length < 3) continue;
    const list = datesByCore.get(core) || [];
    list.push(r.date);
    datesByCore.set(core, list);
  }
  for (const [core, dates] of datesByCore) {
    if (isHabitualCadence(dates)) habitual.add(core);
  }
  return habitual;
}

/** normalize + strip refs — the comparable "merchant identity" of a raw name. */
function coreOf(name: string): string {
  return extractCoreName(normalizeForComparison(name));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a transaction name for comparison: lowercase, collapse whitespace,
 * remove common punctuation.
 */
function normalizeForComparison(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')  // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract the "core" merchant name by stripping reference numbers, store IDs,
 * location info, etc. E.g.:
 *   "STARBUCKS #12345 MIAMI FL" → "starbucks"
 *   "AMEX AUTOPAY 230415" → "amex autopay"
 *   "POS DEBIT VISA CHECK CRD PURCHASE 03/10 CHIPOTLE 1234" → "chipotle"
 */
function extractCoreName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[#\-_:\/\\*]+/g, ' ')      // replace separators
    .replace(/\b\d{4,}\b/g, '')           // drop long numbers (store IDs, dates, refs)
    .replace(/\b\d+\.\d+\b/g, '')        // drop decimal numbers (amounts)
    .replace(/\b(pos|debit|visa|mastercard|check|crd|purchase|credit|card|recurring|autopay|online|pmt|pymt|bill)\b/g, '')
    .replace(/\b[a-z]{2}\b/g, '')        // drop 2-letter state codes (FL, TX, CA)
    .replace(/\s+/g, ' ')
    .trim();
}

export function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0 || lenB === 0) return 0;

  let prev = Array.from({ length: lenB + 1 }, (_, i) => i);
  let curr = new Array<number>(lenB + 1);

  for (let i = 1; i <= lenA; i++) {
    curr[0] = i;
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,       // deletion
        curr[j - 1] + 1,   // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }

  const distance = prev[lenB];
  return 1 - distance / Math.max(lenA, lenB);
}

export function getSharedWordRatio(a: string, b: string): number {
  const wordsA = significantWords(a);
  const wordsB = significantWords(b);

  if (wordsA.size === 0 && wordsB.size === 0) return 1;

  const all = new Set([...wordsA, ...wordsB]);
  if (all.size === 0) return 0;

  let shared = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) shared++;
  }

  return shared / all.size;
}

/**
 * Absolute whole days between two date-only strings, via pure calendar math
 * (lib/dates). The previous Date-object implementation mixed UTC parsing with
 * local-time arithmetic and could be off by one near midnight.
 */
export function daysBetween(date1: string, date2: string): number {
  return daysApart(date1, date2);
}

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}
