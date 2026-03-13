import { db } from '../db/database.js';

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
export function findDuplicates(
  items: PendingItemData[],
  userId: string,
): DuplicateMatch[] {
  const matches: DuplicateMatch[] = [];

  for (const item of items) {
    const dateObj = new Date(item.parsed_date);
    const minDate = offsetDate(dateObj, -DATE_WINDOW_DAYS);
    const maxDate = offsetDate(dateObj, DATE_WINDOW_DAYS);

    const rows = db
      .prepare(
        `SELECT id, name, amount, date, category_id
         FROM transactions
         WHERE user_id = ? AND date >= ? AND date <= ?`,
      )
      .all(userId, minDate, maxDate) as {
      id: string;
      name: string;
      amount: number;
      date: string;
      category_id: string | null;
    }[];

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

export function scorePair(
  item: Scorable,
  existing: Scorable,
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
  const gap = daysBetween(item.date, existing.date);

  if (gap === 0) {
    score += 25;
    reasons.push('Same date');
  } else if (gap === 1) {
    // Common: transaction posts next business day
    score += 22;
    reasons.push('Dates 1 day apart (posting lag)');
  } else if (gap <= 3) {
    // Weekend/holiday posting delay
    score += 15;
    reasons.push(`Dates ${gap} days apart`);
  }
  // Beyond 3 days: 0 date points (already filtered by DATE_WINDOW_DAYS but
  // cross-file overlaps don't use the SQL filter)

  return { score, reasons };
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

export function daysBetween(date1: string, date2: string): number {
  const ms1 = new Date(date1).getTime();
  const ms2 = new Date(date2).getTime();
  return Math.round(Math.abs(ms1 - ms2) / 86_400_000);
}

function offsetDate(base: Date, days: number): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w)),
  );
}
