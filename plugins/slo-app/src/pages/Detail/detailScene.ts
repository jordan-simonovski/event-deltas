import {
  AdHocFiltersVariable,
  EmbeddedScene,
  SceneControlsSpacer,
  SceneFlexItem,
  SceneFlexLayout,
  SceneQueryRunner,
  SceneRefreshPicker,
  SceneTimePicker,
  SceneTimeRange,
  SceneVariableSet,
  VariableValueSelectors,
  VizPanel,
} from '@grafana/scenes';
import { locationService } from '@grafana/runtime';
import { CLICKHOUSE_DS } from '../../constants';
import {
  SLODefinition,
  latencyTimeseriesSql,
  errorRateTimeseriesSql,
  complianceSql,
  errorBudgetSql,
} from '../../sloDefinitions';
import {
  SelectionState,
  AttributeComparisonPanel,
  RepresentativeTracesPanel,
  InvestigationGuidancePanel,
  buildFilterClause,
} from '@heatmap/shared-comparison';
import { heatmapExplorerRoute, heatmapTraceRoute } from '../../utils/crossAppRoutes';

function buildAdHocWhere(slo: SLODefinition, adHocFilters: AdHocFiltersVariable): string {
  const parts: string[] = [
    `SpanAttributes['http.route'] = '${slo.route}'`,
    `ServiceName = 'api-gateway'`,
  ];

  for (const f of adHocFilters.state.filters) {
    const clause = buildFilterClause(f.key, f.value, f.operator);
    if (clause) {
      parts.push(clause);
    }
  }

  return parts.join('\n          AND ');
}

/** How many spans the drilldown heatmap samples. */
const HEATMAP_SAMPLE_SIZE = 10000;

/** Raw span query for heatmap (latency SLOs) */
function buildLatencyDrilldownSql(slo: SLODefinition, adHocFilters: AdHocFiltersVariable): string {
  const where = buildAdHocWhere(slo, adHocFilters);
  // Hash order, not time order: `ORDER BY Timestamp LIMIT n` returns the oldest
  // n spans, which on a busy window is its opening seconds rather than a sample
  // of it. cityHash64 samples the whole window and is stable across refreshes.
  return `SELECT
          Timestamp as timestamp,
          Duration / 1000000 as duration,
          TraceId as traceId
        FROM otel_traces
        WHERE $__timeFilter(Timestamp)
          AND ${where}
        ORDER BY cityHash64(TraceId)
        LIMIT ${HEATMAP_SAMPLE_SIZE}`;
}

/** Aggregated error rate query for timeseries (error_rate SLOs) */
function buildErrorRateDrilldownSql(slo: SLODefinition, adHocFilters: AdHocFiltersVariable): string {
  const where = buildAdHocWhere(slo, adHocFilters);
  return `SELECT
          toStartOfInterval(Timestamp, INTERVAL 1 minute) AS time,
          countIf(toInt32OrZero(SpanAttributes['http.status_code']) >= 500) / count() AS error_rate
        FROM otel_traces
        WHERE $__timeFilter(Timestamp)
          AND ${where}
        GROUP BY time
        ORDER BY time`;
}

function buildDrilldownSql(slo: SLODefinition, adHocFilters: AdHocFiltersVariable): string {
  return slo.type === 'latency'
    ? buildLatencyDrilldownSql(slo, adHocFilters)
    : buildErrorRateDrilldownSql(slo, adHocFilters);
}

export function detailScene(slo: SLODefinition) {
  const timeRange = new SceneTimeRange({
    from: `now-${slo.windowMinutes}m`,
    to: 'now',
  });

  const adHocFilters = new AdHocFiltersVariable({
    name: 'filters',
    label: 'Filters',
    datasource: CLICKHOUSE_DS,
    applyMode: 'manual',
    defaultKeys: [],
    filters: [],
  });

  // --- Top row: compliance stat + error budget ---
  const complianceQuery = new SceneQueryRunner({
    datasource: CLICKHOUSE_DS,
    queries: [{
      refId: 'compliance',
      datasource: CLICKHOUSE_DS,
      rawSql: complianceSql(slo),
      format: 1,
      queryType: 'sql',
    }],
  });

  const budgetQuery = new SceneQueryRunner({
    datasource: CLICKHOUSE_DS,
    queries: [{
      refId: 'budget',
      datasource: CLICKHOUSE_DS,
      rawSql: errorBudgetSql(slo),
      format: 1,
      queryType: 'sql',
    }],
  });

  // --- Middle row: latency-only timeseries ---
  const tsQuery = new SceneQueryRunner({
    datasource: CLICKHOUSE_DS,
    queries: [{
      refId: 'ts',
      datasource: CLICKHOUSE_DS,
      rawSql: slo.type === 'latency'
        ? latencyTimeseriesSql(slo)
        : errorRateTimeseriesSql(slo),
      format: 1,
      queryType: 'sql',
    }],
  });

  const tsTitle = `p99 Latency (threshold: ${slo.thresholdMs}ms)`;

  // --- Bottom row: drilldown viz + comparison ---
  const drilldownQuery = new SceneQueryRunner({
    datasource: CLICKHOUSE_DS,
    queries: [{
      refId: 'drilldown',
      datasource: CLICKHOUSE_DS,
      rawSql: buildDrilldownSql(slo, adHocFilters),
      format: 1,
      queryType: 'sql',
    }],
    maxDataPoints: 10000,
  });

  function refreshDrilldownQuery() {
    const newSql = buildDrilldownSql(slo, adHocFilters);
    const current = drilldownQuery.state.queries[0];
    if ((current as any).rawSql === newSql) {
      return;
    }
    drilldownQuery.setState({
      queries: [{ ...current, rawSql: newSql }],
    });
    drilldownQuery.runQueries();
  }

  const selectionState = new SelectionState();
  const comparisonPanel = new AttributeComparisonPanel({
    datasource: CLICKHOUSE_DS,
  });
  const representativeTracesPanel = new RepresentativeTracesPanel({
    datasource: CLICKHOUSE_DS,
    maxTraces: 12,
    onTraceSelect: (traceId) => {
      locationService.push(heatmapTraceRoute(traceId));
    },
  });

  comparisonPanel.setAdHocVariable(adHocFilters);
  representativeTracesPanel.setAdHocVariable(adHocFilters);

  // Wire selection -> comparison
  selectionState.addActivationHandler(() => {
    const sub = selectionState.subscribeToState((newState, prevState) => {
      if (newState.selection !== prevState.selection) {
        comparisonPanel.setSelection(newState.selection);
        representativeTracesPanel.setSelection(newState.selection);
      }
    });
    return () => sub.unsubscribe();
  });

  // Wire ad-hoc filter changes -> rebuild drilldown + re-run comparison
  adHocFilters.addActivationHandler(() => {
    const sub = adHocFilters.subscribeToState((newState, prevState) => {
      if (newState.filters !== prevState.filters) {
        refreshDrilldownQuery();
        if (comparisonPanel.state.selection) {
          comparisonPanel.setSelection(comparisonPanel.state.selection);
        }
        if (representativeTracesPanel.state.selection) {
          representativeTracesPanel.setSelection(representativeTracesPanel.state.selection);
        }
      }
    });
    return () => sub.unsubscribe();
  });

  return new EmbeddedScene({
    $timeRange: timeRange,
    $variables: new SceneVariableSet({
      variables: [adHocFilters],
    }),
    body: new SceneFlexLayout({
      direction: 'column',
      children: [
        new SceneFlexItem({
          minHeight: 110,
          body: new InvestigationGuidancePanel({
            title: 'Continue investigation',
            summary:
              slo.description ??
              slo.userExperience ??
              'Use SLO context here, then pivot to heatmap explorer for trace-level evidence.',
            kpis: [
              { label: 'SLO', value: slo.name, color: 'blue' },
              { label: 'Type', value: slo.type, color: 'purple' },
              { label: 'Target', value: `${(slo.target * 100).toFixed(1)}%`, color: 'green' },
            ],
            actions: [
              { label: 'Event Deltas', onClick: () => locationService.push(heatmapExplorerRoute()) },
            ],
          }),
        }),
        // Top row: compliance + budget
        new SceneFlexItem({
          height: 100,
          body: new SceneFlexLayout({
            direction: 'row',
            children: [
              new SceneFlexItem({
                body: new VizPanel({
                  title: `Compliance (target: ${(slo.target * 100).toFixed(1)}%)`,
                  pluginId: 'stat',
                  $data: complianceQuery,
                  fieldConfig: {
                    defaults: {
                      unit: 'percentunit',
                      thresholds: {
                        mode: 'absolute' as any,
                        steps: [
                          { value: -Infinity, color: 'red' },
                          { value: slo.target - 0.01, color: 'orange' },
                          { value: slo.target, color: 'green' },
                        ],
                      },
                      decimals: 2,
                    },
                    overrides: [],
                  },
                  options: {
                    colorMode: 'background',
                    graphMode: 'none',
                    reduceOptions: { calcs: ['lastNotNull'] },
                  },
                }),
              }),
              new SceneFlexItem({
                body: new VizPanel({
                  title: 'Error Budget Remaining',
                  pluginId: 'gauge',
                  $data: budgetQuery,
                  fieldConfig: {
                    defaults: {
                      unit: 'percentunit',
                      min: -0.05,
                      max: 0.05,
                      thresholds: {
                        mode: 'absolute' as any,
                        steps: [
                          { value: -Infinity, color: 'red' },
                          { value: 0, color: 'green' },
                        ],
                      },
                      decimals: 3,
                    },
                    overrides: [],
                  },
                  options: {
                    reduceOptions: { calcs: ['lastNotNull'] },
                    showThresholdLabels: false,
                    showThresholdMarkers: true,
                  },
                }),
              }),
            ],
          }),
        }),
        ...(slo.type === 'latency'
          ? [
              // Middle row: latency timeseries
              new SceneFlexItem({
                height: 250,
                body: new VizPanel({
                  title: tsTitle,
                  pluginId: 'timeseries',
                  $data: tsQuery,
                  fieldConfig: {
                    defaults: {
                      custom: {
                        lineWidth: 2,
                        fillOpacity: 10,
                        pointSize: 4,
                        showPoints: 'never' as any,
                        thresholdsStyle: {
                          mode: 'line' as any,
                        },
                      },
                      thresholds: {
                        mode: 'absolute' as any,
                        steps: [
                          { value: -Infinity, color: 'green' },
                          { value: slo.thresholdMs ?? 500, color: 'red' },
                        ],
                      },
                    },
                    overrides: [],
                  },
                  options: {
                    legend: { showLegend: true },
                    tooltip: { mode: 'single' },
                  },
                }),
              }),
            ]
          : []),
        // Bottom: drilldown viz (heatmap for latency, timeseries for error_rate)
        new SceneFlexItem({
          height: 350,
          body: slo.type === 'latency'
            ? new VizPanel({
                title: `Trace Latency Heatmap (${slo.route})`,
                pluginId: 'jordo-event-deltas-panel',
                $data: drilldownQuery,
                options: {
                  yAxisScale: 'log',
                  colorScheme: 'oranges',
                  yBuckets: 40,
                },
              })
            : new VizPanel({
                title: `Error Rate (${slo.route})`,
                pluginId: 'jordo-timeseries-selection-panel',
                $data: drilldownQuery,
                options: {
                  lineColor: '#e53935',
                  fillOpacity: 15,
                  thresholdValue: slo.thresholdRate ?? undefined,
                  thresholdColor: '#fb8c00',
                  yAxisLabel: 'Error Rate',
                },
              }),
        }),
        // Bottom: comparison grid
        new SceneFlexItem({
          minHeight: 400,
          body: comparisonPanel,
        }),
        // Bottom: representative trace IDs list
        new SceneFlexItem({
          minHeight: 220,
          body: representativeTracesPanel,
        }),
      ],
    }),
    controls: [
      new VariableValueSelectors({}),
      new SceneControlsSpacer(),
      selectionState,
      new SceneTimePicker({ isOnCanvas: true }),
      new SceneRefreshPicker({
        intervals: ['10s', '30s', '1m', '5m'],
        isOnCanvas: true,
      }),
    ],
  });
}
