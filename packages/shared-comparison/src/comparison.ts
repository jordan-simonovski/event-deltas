/**
 * Comparison utilities for Event Deltas analysis.
 *
 * Given baseline and selection distributions for an attribute,
 * computes the value with the highest percentage difference.
 */

export interface ValueDistribution {
  value: string;
  count: number;
  percentage: number;
}

export interface ComparisonResult {
  attribute: string;
  baseline: ValueDistribution[];
  selection: ValueDistribution[];
  highestDiffValue: string;
  highestDiffPct: number;
  /** Index into selection array for the highest diff value */
  highestDiffIndex: number;
}

/**
 * Compute the value with the highest difference between selection and baseline.
 *
 * Scoring is directional and selection-first:
 * values are only considered signal when they are over-represented
 * in the selection (selection - baseline > 0).
 */
export function computeComparison(
  attribute: string,
  baseline: ValueDistribution[],
  selection: ValueDistribution[]
): ComparisonResult {
  const baselineMap = new Map<string, number>();
  for (const b of baseline) {
    baselineMap.set(b.value, b.percentage);
  }

  let highestDiff = 0;
  let highestDiffValue = '';
  let highestDiffIndex = 0;

  for (let i = 0; i < selection.length; i++) {
    const sel = selection[i];
    const basePct = baselineMap.get(sel.value) ?? 0;
    const diff = sel.percentage - basePct;
    if (diff > highestDiff) {
      highestDiff = diff;
      highestDiffValue = sel.value;
      highestDiffIndex = i;
    }
  }

  return {
    attribute,
    baseline,
    selection,
    highestDiffValue,
    highestDiffPct: highestDiff,
    highestDiffIndex,
  };
}
