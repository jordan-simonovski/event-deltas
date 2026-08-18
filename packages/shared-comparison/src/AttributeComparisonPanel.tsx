import React, { useCallback } from 'react';
import {
  AdHocFiltersVariable,
  QueryVariable,
  SceneComponentProps,
  SceneObjectBase,
  SceneObjectState,
  sceneGraph,
} from '@grafana/scenes';
import { GrafanaTheme2 } from '@grafana/data';
import { Icon, IconButton, Input, Tooltip, useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';
import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import { HeatmapSelection } from './types';
import { ComparisonResult, ValueDistribution, computeComparison } from './comparison';
import { isHighCardinality } from './comparisonStats';
import { buildComparisonSql } from './comparisonSql';
import { quoteSqlString } from './sqlFilters';
import { getTopDisplayValues } from './displayValues';
import { buildFilterClause } from './sqlFilters';

export interface ComparisonAttribute {
  /** Display label shown on the card */
  label: string;
  /** SQL expression for the column value — e.g. `StatusCode` */
  expr: string;
}

/** One (attribute, value) row of the comparison query. */
interface ComparisonRow {
  key: string;
  value: string;
  selCount: number;
  baseCount: number;
  selTotal: number;
  baseTotal: number;
  distinctValues: number;
}

/** Values kept per attribute. Totals are exact regardless — this only caps what we draw. */
const VALUES_PER_ATTRIBUTE = 20;

/** Beyond this many selected traces, filter by the drawn box instead of by id. */
const MAX_INLINE_TRACE_IDS = 5000;

/** Configuration injected per-app so the panel is datasource/attribute agnostic. */
export interface ComparisonPanelConfig {
  datasource: { uid: string; type: string };
  tracesTable?: string; // default 'otel_traces'
}

interface AttributeComparisonState extends SceneObjectState {
  selection: HeatmapSelection | null;
  results: ComparisonResult[];
  loading: boolean;
  filterText: string;
}

export class AttributeComparisonPanel extends SceneObjectBase<AttributeComparisonState> {
  private static readonly TOP_LEVEL_COLUMNS: ComparisonAttribute[] = [
    { label: 'StatusCode', expr: 'StatusCode' },
    { label: 'ServiceName', expr: 'ServiceName' },
  ];

  private adHocVar: AdHocFiltersVariable | null = null;
  private serviceVar: QueryVariable | null = null;
  private modeFilter = '';
  private readonly config: ComparisonPanelConfig;

  constructor(config: ComparisonPanelConfig) {
    super({ selection: null, results: [], loading: false, filterText: '' });
    this.config = config;
  }

  private get table(): string {
    return this.config.tracesTable ?? 'otel_traces';
  }

  public setAdHocVariable(v: AdHocFiltersVariable) {
    this.adHocVar = v;
  }

  public setServiceVariable(v: QueryVariable) {
    this.serviceVar = v;
  }

  /** Optional SQL WHERE fragment applied to both selection and baseline queries (e.g. status code filter). */
  public setModeFilter(filter: string) {
    this.modeFilter = filter;
  }

  public setSelection(selection: HeatmapSelection | null) {
    this.setState({ selection });
    if (selection) {
      this.runComparison(selection);
    } else {
      this.setState({ results: [], loading: false });
    }
  }

  /** Build the extra WHERE fragments from mode, service variable + ad-hoc filters */
  private getExtraFilters(): string {
    const parts: string[] = [];

    if (this.modeFilter) {
      parts.push(this.modeFilter);
    }

    // Service filter
    if (this.serviceVar) {
      const val = String(this.serviceVar.state.value ?? '%');
      if (val && val !== '' && val !== '$__all') {
        parts.push(`ServiceName = '${val}'`);
      }
    }

    // Ad-hoc filters
    if (this.adHocVar) {
      for (const f of this.adHocVar.state.filters) {
        const clause = buildFilterClause(f.key, f.value, f.operator);
        if (clause) {
          parts.push(clause);
        }
      }
    }

    return parts.length > 0 ? ' AND ' + parts.join(' AND ') : '';
  }

  public addIncludeFilter(attr: string, value: string) {
    if (!this.adHocVar) { return; }
    const existing = this.adHocVar.state.filters;
    if (existing.some((f) => f.key === attr && f.value === value && f.operator === '=')) { return; }
    this.adHocVar.setState({
      filters: [...existing, { key: attr, value, operator: '=', condition: '' }],
    });
    if (this.state.selection) {
      this.runComparison(this.state.selection);
    }
  }

  public addExcludeFilter(attr: string, value: string) {
    if (!this.adHocVar) { return; }
    const existing = this.adHocVar.state.filters;
    if (existing.some((f) => f.key === attr && f.value === value && f.operator === '!=')) { return; }
    this.adHocVar.setState({
      filters: [...existing, { key: attr, value, operator: '!=', condition: '' }],
    });
    if (this.state.selection) {
      this.runComparison(this.state.selection);
    }
  }

  private async runComparison(sel: HeatmapSelection) {
    this.setState({ loading: true });

    const fromMs = Math.floor(sel.timeRange.from);
    const toMs = Math.floor(sel.timeRange.to);

    const extra = this.getExtraFilters();

    // An explicit id list is the exact selection, but it is inlined into the SQL.
    // Past MAX_INLINE_TRACE_IDS the box the user drew says the same thing without
    // shipping a megabyte of literals.
    const traceIdFilter =
      sel.traceIds && sel.traceIds.length > 0 && sel.traceIds.length <= MAX_INLINE_TRACE_IDS
        ? `TraceId IN (${sel.traceIds.map(quoteSqlString).join(', ')})`
        : '';

    let timeAndDuration = `Timestamp >= fromUnixTimestamp64Milli(${fromMs}) AND Timestamp <= fromUnixTimestamp64Milli(${toMs})`;
    if (sel.latencyRange) {
      const minNano = Math.round(sel.latencyRange.min * 1e6);
      const maxNano = Math.round(sel.latencyRange.max * 1e6);
      timeAndDuration += ` AND Duration >= ${minNano} AND Duration <= ${maxNano}`;
    }
    const selectionPredicate = traceIdFilter || timeAndDuration;

    // Baseline is the same window minus the selection — never "everything else, ever".
    const tr = sceneGraph.getTimeRange(this).state.value;
    const panelFrom = Math.floor(tr.from.valueOf());
    const panelTo = Math.floor(tr.to.valueOf());
    const scopeFilter = `Timestamp >= fromUnixTimestamp64Milli(${panelFrom}) AND Timestamp <= fromUnixTimestamp64Milli(${panelTo})${extra}`;

    const sql = buildComparisonSql({
      table: this.table,
      scopeFilter,
      selectionPredicate,
      topLevelColumns: AttributeComparisonPanel.TOP_LEVEL_COLUMNS,
      valuesPerKey: VALUES_PER_ATTRIBUTE,
    });

    let results: ComparisonResult[] = [];
    try {
      results = this.toResults(await this.fetchRows(sql));
    } catch (err) {
      console.error('Comparison query failed:', err);
    }

    this.setState({ results, loading: false });
  }

  private async fetchRows(sql: string): Promise<ComparisonRow[]> {
    const response = await lastValueFrom(
      getBackendSrv().fetch<{ results: Record<string, { frames: Array<{ data: { values: unknown[][] } }> }> }>({
        url: '/api/ds/query',
        method: 'POST',
        data: {
          queries: [
            {
              refId: 'A',
              datasource: this.config.datasource,
              rawSql: sql,
              format: 1,
              queryType: 'sql',
            },
          ],
          from: '0',
          to: String(Date.now()),
        },
      })
    );

    const frame = response.data?.results?.A?.frames?.[0];
    const values = frame?.data?.values;
    if (!values || values.length < 7) {
      return [];
    }

    const [keys, vals, selCnt, baseCnt, selTotal, baseTotal, distinct] = values as [
      string[], string[], number[], number[], number[], number[], number[]
    ];

    return keys.map((key, i) => ({
      key: String(key),
      value: String(vals[i]),
      selCount: Number(selCnt[i]),
      baseCount: Number(baseCnt[i]),
      selTotal: Number(selTotal[i]),
      baseTotal: Number(baseTotal[i]),
      distinctValues: Number(distinct[i]),
    }));
  }

  /** Group the flat rows per attribute, drop identifier-like ones, score the rest. */
  private toResults(rows: ComparisonRow[]): ComparisonResult[] {
    const byKey = new Map<string, ComparisonRow[]>();
    for (const row of rows) {
      const existing = byKey.get(row.key);
      if (existing) {
        existing.push(row);
      } else {
        byKey.set(row.key, [row]);
      }
    }

    const results: ComparisonResult[] = [];
    for (const [key, keyRows] of byKey) {
      const { selTotal, baseTotal, distinctValues } = keyRows[0];
      if (isHighCardinality(distinctValues, selTotal + baseTotal)) {
        continue;
      }

      const selection: ValueDistribution[] = [];
      const baseline: ValueDistribution[] = [];
      for (const row of keyRows) {
        if (row.selCount > 0) {
          selection.push({
            value: row.value,
            count: row.selCount,
            percentage: selTotal > 0 ? row.selCount / selTotal : 0,
          });
        }
        if (row.baseCount > 0) {
          baseline.push({
            value: row.value,
            count: row.baseCount,
            percentage: baseTotal > 0 ? row.baseCount / baseTotal : 0,
          });
        }
      }

      const result = computeComparison(key, baseline, selection, {
        selection: selTotal,
        baseline: baseTotal,
      });
      if (result.score > 0) {
        results.push(result);
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  public setFilterText(text: string) {
    this.setState({ filterText: text });
  }

  public static Component = ({ model }: SceneComponentProps<AttributeComparisonPanel>) => {
    const { selection, results, loading, filterText } = model.useState();
    const styles = useStyles2(getStyles);

    const onFilterChange = useCallback(
      (e: React.ChangeEvent<HTMLInputElement>) => {
        model.setFilterText(e.target.value);
      },
      [model]
    );

    if (!selection) {
      return (
        <div className={styles.placeholder}>
          Select an outlier region, then compare against baseline to isolate causal attributes.
        </div>
      );
    }

    if (loading) {
      return <div className={styles.placeholder}>Loading comparison data...</div>;
    }

    const needle = filterText.toLowerCase();
    const filtered = needle
      ? results.filter((r) => r.attribute.toLowerCase().includes(needle))
      : results;

    if (filtered.length === 0) {
      return (
        <div className={styles.placeholder}>
          No differentiating attributes found for this slice. Try widening time range or changing filters.
        </div>
      );
    }

    return (
      <div>
        <div className={styles.filterBar}>
          <Input
            prefix={<Icon name="search" />}
            placeholder="Filter attributes..."
            value={filterText}
            onChange={onFilterChange}
            width={30}
          />
          <span className={styles.filterCount}>
            {filtered.length} / {results.length} attributes
          </span>
          <span className={styles.selectionSummary}>
            {selection.spanCount != null ? `${selection.spanCount} spans selected` : 'Time range selected'}
          </span>
        </div>
        <SignificanceLegend />
        <div className={styles.grid}>
          {filtered.map((result) => (
            <AttributeCard
              key={result.attribute}
              result={result}
              onInclude={(attr, val) => model.addIncludeFilter(attr, val)}
              onExclude={(attr, val) => model.addExcludeFilter(attr, val)}
            />
          ))}
        </div>
      </div>
    );
  };
}

// --- Significance levels ---

type Significance = 'high' | 'medium' | 'low' | 'none';

const SIGNIFICANCE_META: Record<Significance, { label: string; color: string; description: string }> = {
  high: {
    label: 'Strong signal',
    color: '#e5393580',
    description: 'This attribute strongly differentiates the selected spans from the baseline. Likely a root cause or closely correlated with one.',
  },
  medium: {
    label: 'Moderate signal',
    color: '#fb8c0080',
    description: 'This attribute shows meaningful difference. May be a contributing factor or correlated with the root cause.',
  },
  low: {
    label: 'Weak signal',
    color: '#fdd83580',
    description: 'Small difference. Unlikely to be a cause, but worth noting if other evidence supports it.',
  },
  none: {
    label: 'No signal',
    color: 'transparent',
    description: 'Distribution is similar in selection and baseline. This attribute does not explain the selected outliers.',
  },
};

function getSignificance(diffPct: number): Significance {
  const pct = diffPct * 100;
  if (pct >= 30) { return 'high'; }
  if (pct >= 10) { return 'medium'; }
  if (pct >= 3) { return 'low'; }
  return 'none';
}

// --- Legend ---

function SignificanceLegend() {
  const styles = useStyles2(getLegendStyles);
  return (
    <div className={styles.legend}>
      <span className={styles.legendTitle}>How to read:</span>
      <span className={styles.legendItem}>
        <span className={styles.legendDot} style={{ background: '#e53935' }} />
        <span><b>Strong signal</b> (&ge;30%) -- likely root cause</span>
      </span>
      <span className={styles.legendItem}>
        <span className={styles.legendDot} style={{ background: '#fb8c00' }} />
        <span><b>Moderate</b> (10-30%) -- contributing factor</span>
      </span>
      <span className={styles.legendItem}>
        <span className={styles.legendDot} style={{ background: '#fdd835' }} />
        <span><b>Weak</b> (3-10%) -- minor correlation</span>
      </span>
      <span className={styles.legendItem}>
        <span className={styles.legendDot} style={{ background: '#bdbdbd' }} />
        <span><b>No signal</b> (&lt;3%) -- not a differentiator</span>
      </span>
      <span className={styles.legendSep}>|</span>
      <span className={styles.legendItem}>
        <span className={`${styles.legendBar} ${styles.legendBarBaseline}`} />
        <span>Baseline</span>
      </span>
      <span className={styles.legendItem}>
        <span className={`${styles.legendBar} ${styles.legendBarSelection}`} />
        <span>Selection</span>
      </span>
    </div>
  );
}

// --- Individual attribute comparison card ---

function AttributeCard({
  result,
  onInclude,
  onExclude,
}: {
  result: ComparisonResult;
  onInclude: (attr: string, value: string) => void;
  onExclude: (attr: string, value: string) => void;
}) {
  const styles = useStyles2(getCardStyles);
  const sig = getSignificance(result.highestDiffPct);
  const meta = SIGNIFICANCE_META[sig];
  const maxCount = Math.max(
    ...result.baseline.map((v) => v.percentage),
    ...result.selection.map((v) => v.percentage),
    0.01
  );

  const selMap = new Map(result.selection.map((v) => [v.value, v]));
  const baseMap = new Map(result.baseline.map((v) => [v.value, v]));
  const displayedValues = getTopDisplayValues(result, 10);

  const selTotal = result.selection.reduce((a, b) => a + b.count, 0);
  const baseTotal = result.baseline.reduce((a, b) => a + b.count, 0);

  return (
    <div
      className={styles.card}
      style={{ borderLeftColor: meta.color, borderLeftWidth: '3px' }}
      title={meta.description}
    >
      <div className={styles.header}>
        <span className={styles.attrName}>{result.attribute}</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span className={styles.signBadge} style={{ color: meta.color.replace('80', '') }}>
            {meta.label}
          </span>
          <div className={styles.donutContainer}>
            <DonutPair
              baselinePresence={baseTotal > 0 ? 1 : 0}
              selectionPresence={selTotal > 0 ? 1 : 0}
            />
          </div>
        </div>
      </div>
      <div className={styles.bars}>
        {displayedValues.map((val) => {
          const selPct = selMap.get(val)?.percentage ?? 0;
          const basePct = baseMap.get(val)?.percentage ?? 0;
          return (
            <div key={val} className={styles.barRow}>
              <div className={styles.barWithActions}>
                <div className={styles.barPairWrap}>
                  <div className={styles.barPair}>
                    <div
                      className={styles.barBaseline}
                      style={{ width: `${(basePct / maxCount) * 100}%` }}
                      title={`Baseline: ${(basePct * 100).toFixed(1)}%`}
                    />
                    <div
                      className={styles.barSelection}
                      style={{ width: `${(selPct / maxCount) * 100}%` }}
                      title={`Selection: ${(selPct * 100).toFixed(1)}%`}
                    />
                  </div>
                  <div className={styles.barLabel} title={val}>
                    {val}
                  </div>
                </div>
                <div className={styles.barActions}>
                  <Tooltip content={`Include ${result.attribute}=${val}`} placement="top">
                    <IconButton
                      name="search-plus"
                      size="xs"
                      variant="secondary"
                      aria-label={`Include ${val}`}
                      onClick={() => onInclude(result.attribute, val)}
                    />
                  </Tooltip>
                  <Tooltip content={`Exclude ${result.attribute}=${val}`} placement="top">
                    <IconButton
                      name="search-minus"
                      size="xs"
                      variant="destructive"
                      aria-label={`Exclude ${val}`}
                      onClick={() => onExclude(result.attribute, val)}
                    />
                  </Tooltip>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className={styles.footer}>
        <span className={styles.diffLabel}>Highest diff</span>
        <span
          className={styles.diffValue}
          style={{ color: meta.color.replace('80', '') }}
        >
          {(result.highestDiffPct * 100).toFixed(result.highestDiffPct === 0 ? 0 : 1)}%
        </span>
        <span className={styles.diffAttr} title={result.highestDiffValue}>
          {result.highestDiffValue}
        </span>
      </div>
    </div>
  );
}

function DonutPair({
  baselinePresence,
  selectionPresence,
}: {
  baselinePresence: number;
  selectionPresence: number;
}) {
  const styles = useStyles2(getDonutStyles);
  const size = 16;
  const r = 6;
  const stroke = 3;
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" className={styles.track} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          className={styles.baseline}
          strokeWidth={stroke}
          strokeDasharray={`${baselinePresence * 2 * Math.PI * r} ${2 * Math.PI * r}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" className={styles.track} strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          className={styles.selection}
          strokeWidth={stroke}
          strokeDasharray={`${selectionPresence * 2 * Math.PI * r} ${2 * Math.PI * r}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
    </div>
  );
}

function getDonutStyles(theme: GrafanaTheme2) {
  return {
    track: css({
      stroke: theme.colors.border.weak,
    }),
    baseline: css({
      stroke: theme.colors.primary.main,
    }),
    selection: css({
      stroke: theme.colors.warning.main,
    }),
  };
}

// --- Styles ---

function getStyles(theme: GrafanaTheme2) {
  return {
    placeholder: css({
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: theme.spacing(4),
      color: theme.colors.text.secondary,
      fontSize: '14px',
      minHeight: '200px',
    }),
    filterBar: css({
      display: 'flex',
      alignItems: 'center',
      gap: theme.spacing(1),
      padding: `${theme.spacing(1)} ${theme.spacing(1)} 0`,
    }),
    filterCount: css({
      fontSize: '12px',
      color: theme.colors.text.secondary,
      whiteSpace: 'nowrap',
    }),
    selectionSummary: css({
      fontSize: '12px',
      color: theme.colors.text.primary,
      fontWeight: 500,
      whiteSpace: 'nowrap',
      marginLeft: 'auto',
    }),
    grid: css({
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
      gap: theme.spacing(1),
      padding: theme.spacing(1),
    }),
  };
}

function getCardStyles(theme: GrafanaTheme2) {
  return {
    card: css({
      display: 'flex',
      flexDirection: 'column',
      border: `1px solid ${theme.colors.border.weak}`,
      borderRadius: theme.shape.radius.default,
      background: theme.colors.background.primary,
      padding: theme.spacing(1),
      minHeight: '180px',
    }),
    header: css({
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      marginBottom: theme.spacing(0.5),
    }),
    attrName: css({
      fontWeight: 600,
      fontSize: '12px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }),
    signBadge: css({
      fontSize: '9px',
      fontWeight: 600,
      whiteSpace: 'nowrap',
      textTransform: 'uppercase',
      letterSpacing: '0.5px',
    }),
    donutContainer: css({
      flexShrink: 0,
    }),
    bars: css({
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      gap: '3px',
      overflow: 'hidden',
    }),
    barRow: css({
      display: 'flex',
      flexDirection: 'column',
    }),
    barWithActions: css({
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
      '&:hover > div:last-child': {
        opacity: 1,
      },
    }),
    barPairWrap: css({
      flex: 1,
      minWidth: 0,
      display: 'flex',
      flexDirection: 'column',
      gap: '1px',
    }),
    barPair: css({
      display: 'flex',
      flexDirection: 'column',
      gap: '1px',
      height: '12px',
    }),
    barBaseline: css({
      height: '5px',
      backgroundColor: theme.colors.primary.main,
      borderRadius: '1px',
      transition: 'width 0.3s ease',
    }),
    barSelection: css({
      height: '5px',
      backgroundColor: theme.colors.warning.main,
      borderRadius: '1px',
      transition: 'width 0.3s ease',
    }),
    barLabel: css({
      fontSize: '11px',
      color: theme.colors.text.secondary,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      lineHeight: '1',
    }),
    barActions: css({
      display: 'flex',
      gap: '2px',
      opacity: 0,
      transition: 'opacity 0.15s ease',
      flexShrink: 0,
    }),
    footer: css({
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      marginTop: theme.spacing(0.5),
      paddingTop: theme.spacing(0.5),
      borderTop: `1px solid ${theme.colors.border.weak}`,
    }),
    diffLabel: css({
      fontSize: '10px',
      color: theme.colors.text.secondary,
      fontWeight: 500,
    }),
    diffValue: css({
      fontSize: '20px',
      fontWeight: 'bold',
      lineHeight: '1.2',
    }),
    diffAttr: css({
      fontSize: '12px',
      color: theme.colors.text.secondary,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      maxWidth: '100%',
      textAlign: 'center',
    }),
  };
}

function getLegendStyles(theme: GrafanaTheme2) {
  return {
    legend: css({
      display: 'flex',
      flexWrap: 'wrap',
      alignItems: 'center',
      gap: theme.spacing(1.5),
      padding: `${theme.spacing(0.75)} ${theme.spacing(1)}`,
      margin: `0 ${theme.spacing(1)}`,
      background: theme.colors.background.secondary,
      borderRadius: theme.shape.radius.default,
      fontSize: '11px',
      color: theme.colors.text.secondary,
    }),
    legendTitle: css({
      fontWeight: 600,
      color: theme.colors.text.primary,
      fontSize: '11px',
    }),
    legendItem: css({
      display: 'flex',
      alignItems: 'center',
      gap: '4px',
    }),
    legendDot: css({
      width: '8px',
      height: '8px',
      borderRadius: '50%',
      flexShrink: 0,
    }),
    legendBar: css({
      width: '14px',
      height: '5px',
      borderRadius: '1px',
      flexShrink: 0,
    }),
    legendBarBaseline: css({
      background: theme.colors.primary.main,
    }),
    legendBarSelection: css({
      background: theme.colors.warning.main,
    }),
    legendSep: css({
      color: theme.colors.border.weak,
      fontSize: '14px',
    }),
  };
}
