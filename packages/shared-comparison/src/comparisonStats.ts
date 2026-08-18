/**
 * Sample-size awareness for Event Deltas scoring.
 *
 * A raw percentage-point difference treats "3 of 4 selected spans" and
 * "900 of 1000" as equally strong. These helpers separate effect size (what we
 * display) from confidence (how we rank), so a handful of events cannot
 * outrank a well-evidenced difference.
 */

/** z for a 95% one-sided-ish bound. Two-sided 0.95 is the convention users expect. */
const Z_95 = 1.96;

/** A value needs at least this many events in the selection to be eligible as signal. */
export const MIN_VALUE_OCCURRENCES = 5;

/** Above this share of distinct values, an attribute is an identifier, not a dimension. */
const HIGH_CARDINALITY_RATIO = 0.9;

/** Below this many rows the uniqueness ratio is too noisy to judge. */
const HIGH_CARDINALITY_MIN_ROWS = 20;

/**
 * Absolute distinct-value ceiling for a comparable dimension.
 *
 * The ratio rule alone is inert against a full population: db.statement is 2707
 * distinct over 99k rows, a ratio of 0.03. Measured on the demo stack, every
 * real dimension has <= 10 distinct values while the identifiers start at 500
 * (user.id) — so anything in the hundreds is an id, and a card that draws 20
 * bars cannot say anything useful about it either way.
 */
const HIGH_CARDINALITY_MAX_VALUES = 200;

/**
 * Lower bound of the 95% Agresti-Caffo interval for (p1 - p2).
 *
 * Agresti-Caffo rather than plain Wald: adding one success and one failure to
 * each group keeps the interval sane when a cell is zero or a group is small,
 * which is the common case for a tight heatmap selection.
 *
 * Returns a value that can be negative — callers treat <= 0 as "not
 * distinguishable from baseline".
 */
export function differenceLowerBound(
  selectionCount: number,
  selectionTotal: number,
  baselineCount: number,
  baselineTotal: number,
  z: number = Z_95
): number {
  if (selectionTotal <= 0 || baselineTotal <= 0) {
    return 0;
  }

  const n1 = selectionTotal + 2;
  const n2 = baselineTotal + 2;
  const p1 = (selectionCount + 1) / n1;
  const p2 = (baselineCount + 1) / n2;

  const se = Math.sqrt((p1 * (1 - p1)) / n1 + (p2 * (1 - p2)) / n2);
  return p1 - p2 - z * se;
}

/**
 * Is this attribute an identifier (trace id, user id, pod-scoped uuid) rather
 * than a dimension worth comparing? Nearly-unique values cannot differentiate
 * anything — every value appears once on each side.
 */
export function isHighCardinality(distinctValues: number, rows: number): boolean {
  if (distinctValues > HIGH_CARDINALITY_MAX_VALUES) {
    return true;
  }
  if (rows < HIGH_CARDINALITY_MIN_ROWS) {
    return false;
  }
  return distinctValues / rows > HIGH_CARDINALITY_RATIO;
}
