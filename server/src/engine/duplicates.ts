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

const MATCH_THRESHOLD = 50;
const DATE_WINDOW_DAYS = 7;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'payment', 'purchase', 'to', 'for', 'and', 'in',
]);

// ---------------------------------------------------------------------------
// Main entry points
// ---------------------------------------------------------------------------

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
      const { score, reasons } = scorePair(
        {
          name: item.parsed_name,
          amount: item.parsed_amount,
          date: item.parsed_date,
          categoryId: item.matched_category_id,
        },
        {
          name: row.name,
          amount: row.amount,
          date: row.date,
          categoryId: row.category_id ?? undefined,
        },
      );

      if (score >= MATCH_THRESHOLD) {
        matches.push({
          itemId: item.id,
          matchedTransactionId: row.id,
          score,
          reasons,
          matchType: 'existing',
        });
      }
    }
  }

  return matches;
}

export function findCrossFileOverlaps(
  items: PendingItemData[],
): DuplicateMatch[] {
  const matches: DuplicateMatch[] = [];

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i];
      const b = items[j];

      if (a.file_id === b.file_id) continue;

      const { score, reasons } = scorePair(
        {
          name: a.parsed_name,
          amount: a.parsed_amount,
          date: a.parsed_date,
          categoryId: a.matched_category_id,
        },
        {
          name: b.parsed_name,
          amount: b.parsed_amount,
          date: b.parsed_date,
          categoryId: b.matched_category_id,
        },
      );

      if (score >= MATCH_THRESHOLD) {
        matches.push({
          itemId: a.id,
          matchedTransactionId: b.id,
          score,
          reasons,
          matchType: 'cross_file',
        });
      }
    }
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface Scorable {
  name: string;
  amount: number;
  date: string;
  categoryId?: string;
}

export function scorePair(
  item: Scorable,
  existing: Scorable,
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // --- Amount (35 pts max) ---
  const amtDiff =
    existing.amount === 0
      ? (item.amount === 0 ? 0 : 1)
      : Math.abs(item.amount - existing.amount) / Math.abs(existing.amount);

  if (item.amount === existing.amount) {
    score += 35;
    reasons.push(`Exact amount match ($${item.amount.toFixed(2)})`);
  } else if (amtDiff <= 0.01) {
    score += 25;
    reasons.push('Very similar amount');
  } else if (amtDiff <= 0.05) {
    score += 15;
    reasons.push('Similar amount range');
  }

  // --- Date proximity (25 pts max) ---
  const gap = daysBetween(item.date, existing.date);

  if (gap === 0) {
    score += 25;
    reasons.push('Same date');
  } else if (gap <= 1) {
    score += 20;
    reasons.push('Dates within 1 day');
  } else if (gap <= 3) {
    score += 15;
    reasons.push('Dates within 3 days');
  } else if (gap <= 7) {
    score += 8;
    reasons.push('Dates within a week');
  }

  // --- Name similarity (25 pts max) ---
  const nameA = item.name.trim().toLowerCase();
  const nameB = existing.name.trim().toLowerCase();

  if (nameA === nameB) {
    score += 25;
    reasons.push('Exact name match');
  } else if (nameA.includes(nameB) || nameB.includes(nameA)) {
    score += 20;
    reasons.push('Similar description');
  } else if (levenshteinSimilarity(nameA, nameB) > 0.7) {
    score += 15;
    reasons.push('Close name match');
  } else if (getSharedWordRatio(nameA, nameB) > 0.5) {
    score += 10;
    reasons.push('Shared keywords');
  }

  // --- Category (15 pts max) ---
  if (item.categoryId && existing.categoryId) {
    if (item.categoryId === existing.categoryId) {
      score += 15;
      reasons.push('Same category');
    }
  } else if (!item.categoryId && !existing.categoryId) {
    score += 5;
  }

  return { score, reasons };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function levenshteinSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0 || lenB === 0) return 0;

  // Build distance matrix (space-optimised to two rows)
  let prev = Array.from({ length: lenB + 1 }, (_, i) => i);
  let curr = new Array<number>(lenB + 1);

  for (let i = 1; i <= lenA; i++) {
    curr[0] = i;
    for (let j = 1; j <= lenB; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
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

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

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
      .filter((w) => w.length > 0 && !STOP_WORDS.has(w)),
  );
}
