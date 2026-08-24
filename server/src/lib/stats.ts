/**
 * Robust statistics shared by the detection engine.
 *
 * The house rule: never characterize money distributions with a mean. Spend
 * data is right-skewed and a single large transaction drags a mean (and any
 * `3 × mean` threshold) far enough to hide itself — audit D13. Median + MAD
 * are the drop-in robust replacements.
 *
 * `detectRobustOutliers` is exported for analysis.ts (owned elsewhere) to
 * adopt in place of its `> 3 × mean` category-outlier rule at
 * analysis.ts:653-662.
 */

/** Median of a list. 0 for an empty list. */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
}

/** Median absolute deviation (raw, not scaled). */
export function mad(xs: number[], med: number = median(xs)): number {
  if (xs.length === 0) return 0;
  return median(xs.map((x) => Math.abs(x - med)));
}

/**
 * Robust z-score: 0.6745·(x − median)/MAD, the MAD-consistent estimate of a
 * standard z under normality. Returns 0 when MAD is 0 (caller must apply its
 * own degenerate-distribution rule; see detectRobustOutliers).
 */
export function robustZ(x: number, med: number, madValue: number): number {
  if (madValue === 0) return 0;
  return (0.6745 * (x - med)) / madValue;
}

export interface OutlierResult {
  index: number;
  value: number;
  /** Robust z-score (0 when the distribution was degenerate and the absolute-dollar rule fired). */
  z: number;
  median: number;
  mad: number;
}

/**
 * Robust outlier detection over a set of (positive) spend amounts.
 *
 * - Primary rule: |robust z| ≥ threshold (default 3.5).
 * - Degenerate fallback (MAD = 0, i.e. more than half the values identical):
 *   flag x > median + max($50, 0.5·median) — the absolute-dollar rule from the
 *   v2 design spec §3.1, which is exactly right for fixed-price merchants.
 *
 * Unlike a `3 × mean` gate, one huge transaction cannot inflate the yardstick
 * it is measured against, so it can no longer hide itself.
 */
export function detectRobustOutliers(values: number[], threshold = 3.5): OutlierResult[] {
  if (values.length < 3) return [];
  const med = median(values);
  const m = mad(values, med);
  const out: OutlierResult[] = [];
  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    if (m > 0) {
      const z = robustZ(x, med, m);
      if (Math.abs(z) >= threshold) out.push({ index: i, value: x, z, median: med, mad: m });
    } else if (x > med + Math.max(50, 0.5 * med)) {
      out.push({ index: i, value: x, z: 0, median: med, mad: m });
    }
  }
  return out;
}
