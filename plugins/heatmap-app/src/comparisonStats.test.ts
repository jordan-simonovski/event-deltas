// Jest globals imported explicitly: @types/jest is hoisted to repo-root node_modules,
// outside the scaffold's typeRoots, so tsc can't see ambient describe/it/expect.
import { describe, expect, it } from '@jest/globals';
// Import via the package alias (external to tsc's rootDir), NOT a relative source
// path, to avoid pulling shared-comparison src into heatmap-app's program (TS6059).
// require after the IntersectionObserver polyfill: the alias's index re-exports a
// scene object whose LazyLoader touches IntersectionObserver at import time.
global.IntersectionObserver = class IntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof IntersectionObserver;

const { differenceLowerBound, isHighCardinality, computeComparison } =
  require('@heatmap/shared-comparison') as typeof import('@heatmap/shared-comparison');
type ValueDistribution = import('@heatmap/shared-comparison').ValueDistribution;

function dist(value: string, count: number, total: number): ValueDistribution {
  return { value, count, percentage: total > 0 ? count / total : 0 };
}

describe('differenceLowerBound', () => {
  it('is below the observed difference', () => {
    const observed = 900 / 1000 - 100 / 1000;
    expect(differenceLowerBound(900, 1000, 100, 1000)).toBeLessThan(observed);
  });

  it('punishes a small sample harder than a large one at the same observed difference', () => {
    const small = differenceLowerBound(3, 4, 100, 1000);
    const large = differenceLowerBound(750, 1000, 100, 1000);
    expect(small).toBeLessThan(large);
  });

  it('finds no signal when a tiny selection matches the baseline rate', () => {
    expect(differenceLowerBound(1, 10, 100, 1000)).toBeLessThanOrEqual(0);
  });

  it('returns 0 for empty groups rather than NaN', () => {
    expect(differenceLowerBound(0, 0, 0, 0)).toBe(0);
  });
});

describe('isHighCardinality', () => {
  it('flags near-unique values as identifiers', () => {
    expect(isHighCardinality(30, 30)).toBe(true);
  });

  it('flags an id-like attribute even when the population dwarfs its cardinality', () => {
    // db.statement on the demo stack: 2707 distinct over 99k rows, ratio 0.03.
    expect(isHighCardinality(2707, 99001)).toBe(true);
    expect(isHighCardinality(500, 159071)).toBe(true);
  });

  it('keeps a dimension with a handful of values in a large population', () => {
    expect(isHighCardinality(8, 149739)).toBe(false);
  });

  it('leaves a low-cardinality dimension alone', () => {
    expect(isHighCardinality(3, 148416)).toBe(false);
  });

  it('does not judge on too few rows', () => {
    expect(isHighCardinality(10, 10)).toBe(false);
  });
});

describe('computeComparison sample-size awareness', () => {
  it('prefers a well-evidenced difference over a larger difference on three events', () => {
    // 'rare' is 100% of a 3-event corner; 'common' is 70% of 700 against a 10% baseline.
    const selection = [dist('common', 700, 1000), dist('rare', 3, 1000)];
    const baseline = [dist('common', 100, 1000), dist('rare', 0, 1000)];

    const result = computeComparison('attr', baseline, selection, { selection: 1000, baseline: 1000 });

    expect(result.highestDiffValue).toBe('common');
  });

  it('ignores values below the occurrence floor', () => {
    const selection = [dist('rare', 3, 3)];
    const baseline = [dist('other', 1000, 1000)];

    const result = computeComparison('attr', baseline, selection, { selection: 3, baseline: 1000 });

    expect(result.highestDiffValue).toBe('');
    expect(result.score).toBe(0);
  });

  it('reports the observed difference for display, and a smaller score for ranking', () => {
    const selection = [dist('500', 60, 100)];
    const baseline = [dist('500', 10, 100)];

    const result = computeComparison('StatusCode', baseline, selection, { selection: 100, baseline: 100 });

    expect(result.highestDiffPct).toBeCloseTo(0.5);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(result.highestDiffPct);
  });
});
