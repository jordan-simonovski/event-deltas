import { escapeSql } from './sqlFilters';

export interface ComparisonSqlColumn {
  /** Display label shown on the card. */
  label: string;
  /** SQL expression for the column value — e.g. `StatusCode`. */
  expr: string;
}

export interface ComparisonSqlOptions {
  table: string;
  /** WHERE fragment scoping BOTH groups: panel time range, mode filter, ad-hoc filters. */
  scopeFilter: string;
  /** Predicate marking a row as inside the selection. Baseline is its negation, within scope. */
  selectionPredicate: string;
  /** Top-level columns compared alongside the SpanAttributes map. */
  topLevelColumns: ComparisonSqlColumn[];
  /** Max values kept per attribute. */
  valuesPerKey: number;
}

/**
 * One query for the whole comparison, replacing two queries per attribute.
 *
 * Two properties matter beyond the round-trip saving. Group totals come from
 * `sum(...) OVER (PARTITION BY key)`, computed before `LIMIT n BY key`, so
 * percentages use the real denominator instead of the truncated top-N — the
 * old per-attribute queries divided by the sum of the 20 rows they kept.
 * `distinct_values` lets the caller drop identifier-like attributes.
 */
export function buildComparisonSql(o: ComparisonSqlOptions): string {
  const topLevel = o.topLevelColumns
    .map((c) => `tuple('${escapeSql(c.label)}', toString(${c.expr}))`)
    .join(', ');

  const pairs = topLevel
    ? `arrayConcat([${topLevel}], CAST(SpanAttributes, 'Array(Tuple(String, String))'))`
    : `CAST(SpanAttributes, 'Array(Tuple(String, String))')`;

  return `SELECT
  key,
  value,
  sel_cnt,
  base_cnt,
  sum(sel_cnt) OVER (PARTITION BY key) AS sel_total,
  sum(base_cnt) OVER (PARTITION BY key) AS base_total,
  count() OVER (PARTITION BY key) AS distinct_values
FROM (
  SELECT
    tupleElement(kv, 1) AS key,
    tupleElement(kv, 2) AS value,
    countIf(in_sel) AS sel_cnt,
    countIf(NOT in_sel) AS base_cnt
  FROM (
    SELECT
      (${o.selectionPredicate}) AS in_sel,
      ${pairs} AS kvs
    FROM ${o.table}
    WHERE ${o.scopeFilter}
  )
  ARRAY JOIN kvs AS kv
  WHERE tupleElement(kv, 2) != ''
  GROUP BY key, value
)
ORDER BY key, sel_cnt DESC
LIMIT ${Math.max(1, Math.floor(o.valuesPerKey))} BY key`;
}
