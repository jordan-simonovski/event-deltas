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

const { buildComparisonSql } =
  require('@heatmap/shared-comparison') as typeof import('@heatmap/shared-comparison');

const options = {
  table: 'otel_traces',
  scopeFilter: "Timestamp >= fromUnixTimestamp64Milli(1) AND Timestamp <= fromUnixTimestamp64Milli(2) AND ServiceName = 'api-gateway'",
  selectionPredicate: "TraceId IN ('a', 'b')",
  topLevelColumns: [
    { label: 'StatusCode', expr: 'StatusCode' },
    { label: 'ServiceName', expr: 'ServiceName' },
  ],
  valuesPerKey: 20,
};

describe('buildComparisonSql', () => {
  it('scopes both groups to the same window and splits them by the selection predicate', () => {
    const sql = buildComparisonSql(options);

    expect(sql).toContain(`WHERE ${options.scopeFilter}`);
    expect(sql).toContain(`(${options.selectionPredicate}) AS in_sel`);
    expect(sql).toContain('countIf(in_sel) AS sel_cnt');
    expect(sql).toContain('countIf(NOT in_sel) AS base_cnt');
  });

  it('takes totals from a window function so they survive the per-key limit', () => {
    const sql = buildComparisonSql(options);

    expect(sql).toContain('sum(sel_cnt) OVER (PARTITION BY key) AS sel_total');
    expect(sql).toContain('sum(base_cnt) OVER (PARTITION BY key) AS base_total');
    expect(sql.indexOf('OVER (PARTITION BY key)')).toBeLessThan(sql.indexOf('LIMIT 20 BY key'));
  });

  it('compares top-level columns alongside the attribute map', () => {
    const sql = buildComparisonSql(options);

    expect(sql).toContain("tuple('StatusCode', toString(StatusCode))");
    expect(sql).toContain("CAST(SpanAttributes, 'Array(Tuple(String, String))')");
  });

  it('reports distinct value counts so identifiers can be dropped', () => {
    expect(buildComparisonSql(options)).toContain('count() OVER (PARTITION BY key) AS distinct_values');
  });

  it('escapes quotes in a column label', () => {
    const sql = buildComparisonSql({
      ...options,
      topLevelColumns: [{ label: "it's", expr: 'StatusCode' }],
    });

    expect(sql).toContain("tuple('it\\'s', toString(StatusCode))");
  });

  it('never emits a zero or fractional per-key limit', () => {
    expect(buildComparisonSql({ ...options, valuesPerKey: 0 })).toContain('LIMIT 1 BY key');
    expect(buildComparisonSql({ ...options, valuesPerKey: 7.9 })).toContain('LIMIT 7 BY key');
  });
});
