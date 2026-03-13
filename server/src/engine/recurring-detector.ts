// ---------------------------------------------------------------------------
// Recurring Transaction Detector
// ---------------------------------------------------------------------------
// Analyzes transaction history to find TRUE recurring charges:
//   1. Same merchant (core name match)
//   2. Consistent amount (within 5% tolerance for minor price changes)
//   3. Regular interval (weekly, biweekly, monthly, quarterly, annual)
//
// This prevents false positives like "you go to Starbucks a lot" being
// treated as a recurring subscription.
// ---------------------------------------------------------------------------

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
  avgIntervalDays: number;   // average days between charges
}

export type RecurringFrequency =
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'quarterly'
  | 'semi-annual'
  | 'annual'
  | 'irregular';

interface TransactionRow {
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
// Main detection function
// ---------------------------------------------------------------------------

export function detectRecurring(transactions: TransactionRow[]): RecurringCandidate[] {
  // 1. Group transactions by core name
  const groups = new Map<string, {
    names: Map<string, number>;
    entries: Array<{ amount: number; date: string }>;
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
    g.entries.push({ amount: Math.abs(tx.amount), date: tx.date });
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

    // --- Amount consistency check ---
    const amounts = g.entries.map(e => e.amount);
    const medianAmount = median(amounts);

    // Calculate how consistent the amounts are
    // A recurring charge should have very consistent amounts
    const amountVariance = amounts.reduce((sum, a) => {
      if (medianAmount === 0) return sum;
      return sum + Math.abs(a - medianAmount) / medianAmount;
    }, 0) / amounts.length;

    // If amounts vary by more than 15% on average, it's not a fixed recurring charge
    // (e.g., variable grocery spending at the same store)
    const isConsistentAmount = amountVariance <= 0.15;

    if (!isConsistentAmount) continue;

    // --- Interval analysis ---
    const dates = g.entries.map(e => new Date(e.date).getTime());
    const intervals: number[] = [];
    for (let i = 1; i < dates.length; i++) {
      const daysBetween = Math.round((dates[i] - dates[i - 1]) / 86_400_000);
      if (daysBetween > 0) intervals.push(daysBetween);
    }

    if (intervals.length === 0) continue;

    const avgInterval = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    const frequency = classifyFrequency(avgInterval, intervals);

    // Skip irregular patterns — they're not truly recurring
    if (frequency === 'irregular') continue;

    // --- Confidence scoring ---
    let confidence = 0;

    // Amount consistency (0–0.35)
    if (amountVariance <= 0.005) confidence += 0.35;      // exact same amount every time
    else if (amountVariance <= 0.02) confidence += 0.30;   // very minor variation (price change)
    else if (amountVariance <= 0.05) confidence += 0.25;   // small variation
    else if (amountVariance <= 0.15) confidence += 0.15;   // moderate variation

    // Interval consistency (0–0.35)
    const intervalVariance = intervals.reduce((sum, iv) => {
      return sum + Math.abs(iv - avgInterval) / Math.max(avgInterval, 1);
    }, 0) / intervals.length;

    if (intervalVariance <= 0.1) confidence += 0.35;       // very regular timing
    else if (intervalVariance <= 0.2) confidence += 0.28;  // mostly regular
    else if (intervalVariance <= 0.35) confidence += 0.20; // somewhat regular
    else confidence += 0.10;                                // irregular but still has a pattern

    // Occurrences bonus (0–0.20)
    const occurrences = g.entries.length;
    if (occurrences >= 6) confidence += 0.20;
    else if (occurrences >= 4) confidence += 0.15;
    else if (occurrences >= 3) confidence += 0.10;
    else confidence += 0.05;  // just 2 occurrences

    // Distinct months bonus (0–0.10)
    const distinctMonths = new Set(g.entries.map(e => e.date.slice(0, 7))).size;
    if (distinctMonths >= 4) confidence += 0.10;
    else if (distinctMonths >= 3) confidence += 0.07;
    else if (distinctMonths >= 2) confidence += 0.04;

    // Only include candidates with reasonable confidence
    if (confidence < 0.40) continue;

    // Pick most common original name
    let bestName = '';
    let bestCount = 0;
    for (const [n, count] of g.names) {
      if (count > bestCount) { bestName = n; bestCount = count; }
    }

    const latestDate = g.entries[g.entries.length - 1].date;

    candidates.push({
      name: bestName,
      coreName: core,
      amount: round2(medianAmount),
      frequency,
      confidence: round2(confidence),
      monthCount: distinctMonths,
      occurrences,
      category_id: g.category_id,
      category_name: g.category_name,
      category_icon: g.category_icon,
      category_color: g.category_color,
      latestDate,
      avgIntervalDays: Math.round(avgInterval),
    });
  }

  // Sort by confidence descending
  candidates.sort((a, b) => b.confidence - a.confidence);

  return candidates;
}

// ---------------------------------------------------------------------------
// Frequency classification
// ---------------------------------------------------------------------------

function classifyFrequency(avgDays: number, intervals: number[]): RecurringFrequency {
  // Check if intervals are reasonably consistent for each frequency type.
  // We use the average interval plus tolerance bands.

  // Weekly: ~7 days (5-10 day tolerance)
  if (avgDays >= 5 && avgDays <= 10) {
    if (isConsistentInterval(intervals, 7, 3)) return 'weekly';
  }

  // Biweekly: ~14 days (11-18 day tolerance)
  if (avgDays >= 11 && avgDays <= 18) {
    if (isConsistentInterval(intervals, 14, 4)) return 'biweekly';
  }

  // Monthly: ~30 days (25-35 day tolerance)
  if (avgDays >= 25 && avgDays <= 35) {
    if (isConsistentInterval(intervals, 30, 5)) return 'monthly';
  }

  // Quarterly: ~90 days (80-100 day tolerance)
  if (avgDays >= 80 && avgDays <= 100) {
    if (isConsistentInterval(intervals, 91, 10)) return 'quarterly';
  }

  // Semi-annual: ~180 days (165-195 day tolerance)
  if (avgDays >= 165 && avgDays <= 195) {
    if (isConsistentInterval(intervals, 182, 15)) return 'semi-annual';
  }

  // Annual: ~365 days (350-380 day tolerance)
  if (avgDays >= 350 && avgDays <= 380) {
    if (isConsistentInterval(intervals, 365, 15)) return 'annual';
  }

  return 'irregular';
}

/**
 * Check if at least 70% of intervals fall within the expected range.
 */
function isConsistentInterval(intervals: number[], expected: number, tolerance: number): boolean {
  if (intervals.length === 0) return false;
  const withinRange = intervals.filter(
    iv => Math.abs(iv - expected) <= tolerance
  ).length;
  return (withinRange / intervals.length) >= 0.7;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}
