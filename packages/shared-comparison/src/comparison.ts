/**
 * Comparison utilities for Event Deltas analysis.
 *
 * Given baseline and selection distributions for an attribute,
 * computes the value with the highest percentage difference.
 */

import { MIN_VALUE_OCCURRENCES, differenceLowerBound } from './comparisonStats';

export interface ValueDistribution {
  value: string;
  count: number;
  percentage: number;
}

/** Exact group sizes. Without these the totals are inferred from the values we were given. */
export interface ComparisonTotals {
  selection: number;
  baseline: number;
}

export interface ComparisonResult {
  attribute: string;
  baseline: ValueDistribution[];
  selection: ValueDistribution[];
  highestDiffValue: string;
  highestDiffPct: number;
  /** Index into selection array for the highest diff value */
  highestDiffIndex: number;
  /**
   * Confidence-adjusted difference used for ranking: the lower bound of the 95%
   * interval on (selection - baseline). Always <= highestDiffPct, and near zero
   * when the selection is too small to trust. 0 when there is no signal.
   */
  score: number;
}

/**
 * Compute the value with the highest difference between selection and baseline.
 *
 * Scoring is directional and selection-first:
 * values are only considered signal when they are over-represented
 * in the selection (selection - baseline > 0).
 *
 * Among those, the winner is the one with the strongest *confidence-adjusted*
 * difference, so a value seen three times cannot outrank one seen nine hundred
 * times. `highestDiffPct` still reports the observed difference — that is the
 * effect size a user reads — while `score` carries the confidence used to rank
 * and to decide whether the attribute is worth showing at all.
 */
export function computeComparison(
  attribute: string,
  baseline: ValueDistribution[],
  selection: ValueDistribution[],
  totals?: ComparisonTotals
): ComparisonResult {
  const baselineMap = new Map<string, ValueDistribution>();
  for (const b of baseline) {
    baselineMap.set(b.value, b);
  }

  const selectionTotal = totals?.selection ?? sumCounts(selection);
  const baselineTotal = totals?.baseline ?? sumCounts(baseline);

  let bestScore = 0;
  let bestDiff = 0;
  let bestValue = '';
  let bestIndex = 0;

  for (let i = 0; i < selection.length; i++) {
    const sel = selection[i];
    const base = baselineMap.get(sel.value);
    const diff = sel.percentage - (base?.percentage ?? 0);

    if (diff <= 0 || sel.count < MIN_VALUE_OCCURRENCES) {
      continue;
    }

    const score = differenceLowerBound(sel.count, selectionTotal, base?.count ?? 0, baselineTotal);
    if (score <= 0) {
      continue;
    }

    if (score > bestScore) {
      bestScore = score;
      bestDiff = diff;
      bestValue = sel.value;
      bestIndex = i;
    }
  }

  return {
    attribute,
    baseline,
    selection,
    highestDiffValue: bestValue,
    highestDiffPct: bestDiff,
    highestDiffIndex: bestIndex,
    score: bestScore,
  };
}

function sumCounts(values: ValueDistribution[]): number {
  return values.reduce((total, v) => total + v.count, 0);
}
