import {
  AdHocFiltersVariable,
  CustomVariable,
  EmbeddedScene,
  QueryVariable,
  SceneControlsSpacer,
  SceneDataTransformer,
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
import { ROUTES } from '../../constants';
import { getAppConfig } from '../../appConfig';
import { prefixRoute } from '../../utils/utils.routing';
import { SelectionState } from '../../components/Deltas/SelectionState';
import { AttributeComparisonPanel } from '../../components/Deltas/AttributeComparisonPanel';
import { RepresentativeTracesPanel } from '../../components/Deltas/RepresentativeTracesPanel';
import { ViewModeControl } from '../../components/Deltas/ViewModeControl';
import {
  InvestigationGuidancePanel,
  SaturationPanel,
  buildFilterClause,
  buildResourceSeriesSql,
  buildResourceDetailSql,
} from '@heatmap/shared-comparison';

export type WorkbenchView = 'explorer' | 'comparisons' | 'evidence';

/**
 * Build the heatmap SQL with the current service + ad-hoc filter state baked in.
 * We do NOT use ${filters:raw} because the ClickHouse datasource SQL parser
 * chokes on the table.column dot-notation it produces.
 */
function buildHeatmapSql(
  serviceVar: QueryVariable,
  adHocFilters: AdHocFiltersVariable,
  mode: string,
  maxSamples: number,
  tracesTable: string
): string {
  const parts: string[] = [];

  const svc = String(serviceVar.state.value ?? '%');
  if (svc && svc !== '' && svc !== '$__all') {
    parts.push(`ServiceName = '${svc}'`);
  }

  for (const f of adHocFilters.state.filters) {
    const clause = buildFilterClause(f.key, f.value, f.operator);
    if (clause) {
      parts.push(clause);
    }
  }

  const extra = parts.length > 0 ? '\n          AND ' + parts.join('\n          AND ') : '';
  const errorCol = mode === 'errors' ? `,\n          StatusCode = 'Error' as isError` : '';

  // Ordering by hash, not by time. `ORDER BY Timestamp LIMIT n` returns the
  // oldest n rows, so on a busy window the heatmap only ever showed its opening
  // seconds — measured at 54s of a 900s window. Hashing TraceId samples the
  // whole window instead, and is stable across refreshes.
  return `SELECT
          Timestamp as timestamp,
          Duration / 1000000 as duration,
          TraceId as traceId${errorCol}
        FROM ${tracesTable}
        WHERE $__timeFilter(Timestamp)${extra}
        ORDER BY cityHash64(TraceId)
        LIMIT ${maxSamples}`;
}

export function deltasScene(view: WorkbenchView = 'explorer') {
  const { datasource: CLICKHOUSE_DS, tracesTable } = getAppConfig();
  const timeRange = new SceneTimeRange({
    from: 'now-15m',
    to: 'now',
  });

  const serviceVar = new QueryVariable({
    name: 'service',
    label: 'Service',
    datasource: CLICKHOUSE_DS,
    query: {
      rawSql: `SELECT DISTINCT ServiceName FROM ${tracesTable} WHERE ServiceName != '' ORDER BY ServiceName`,
      format: 1,
      queryType: 'sql',
      refId: 'serviceVar',
    } as any,
    defaultToAll: true,
    includeAll: true,
    allValue: '%',
  });

  const viewMode = new ViewModeControl();

  const adHocFilters = new AdHocFiltersVariable({
    name: 'filters',
    label: 'Filters',
    datasource: CLICKHOUSE_DS,
    applyMode: 'manual',
    defaultKeys: [],
    filters: [],
  });

  // Sample size trades detail for query latency. The heatmap is a sample either
  // way; this only controls how large a one.
  const samplesVar = new CustomVariable({
    name: 'samples',
    label: 'Sample size',
    query: '1000,5000,10000,25000,50000',
    value: '10000',
  });

  const currentMode = () => viewMode.state.mode;
  const currentSamples = () => {
    const parsed = Number(samplesVar.state.value);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 10000;
  };

  const heatmapQuery = new SceneQueryRunner({
    datasource: CLICKHOUSE_DS,
    queries: [
      {
        refId: 'heatmap',
        datasource: CLICKHOUSE_DS,
        rawSql: buildHeatmapSql(serviceVar, adHocFilters, currentMode(), currentSamples(), tracesTable),
        format: 1,
        queryType: 'sql',
      },
    ],
    maxDataPoints: 10000,
  });

  function refreshHeatmapQuery() {
    const newSql = buildHeatmapSql(serviceVar, adHocFilters, currentMode(), currentSamples(), tracesTable);
    const current = heatmapQuery.state.queries[0];
    if ((current as any).rawSql === newSql) {
      return;
    }
    heatmapQuery.setState({
      queries: [{ ...current, rawSql: newSql }],
    });
    heatmapQuery.runQueries();
  }

  const servicesFromVar = (): string[] => {
    const val = String(serviceVar.state.value ?? '');
    return val && val !== '$__all' && val !== '%' ? [val] : [];
  };

  const stripQuery = new SceneQueryRunner({
    datasource: CLICKHOUSE_DS,
    queries: [
      {
        refId: 'saturationStrip',
        datasource: CLICKHOUSE_DS,
        rawSql: buildResourceSeriesSql(servicesFromVar()),
        format: 1,
        queryType: 'sql',
      } as any,
    ],
  });

  function refreshStripQuery() {
    const newSql = buildResourceSeriesSql(servicesFromVar());
    const current = stripQuery.state.queries[0];
    if ((current as any).rawSql === newSql) {
      return;
    }
    stripQuery.setState({ queries: [{ ...current, rawSql: newSql }] });
    stripQuery.runQueries();
  }

  // The query returns one row per (time, service); partitionByValues splits it
  // into one series per service so each service's saturation is its own line —
  // a global max() would otherwise let the busiest service hide the others.
  const stripData = new SceneDataTransformer({
    $data: stripQuery,
    transformations: [
      {
        id: 'partitionByValues',
        options: { fields: ['service'], keepFields: false },
      },
    ],
  });

  const selectionState = new SelectionState();
  const comparisonPanel = new AttributeComparisonPanel({
    datasource: CLICKHOUSE_DS,
    tracesTable,
  });
  const representativeTracesPanel = new RepresentativeTracesPanel({
    datasource: CLICKHOUSE_DS,
    tracesTable,
    maxTraces: 10,
    onTraceSelect: (traceId) => {
      locationService.push(prefixRoute(`${ROUTES.Trace}/${encodeURIComponent(traceId)}`));
    },
  });

  comparisonPanel.setAdHocVariable(adHocFilters);
  comparisonPanel.setServiceVariable(serviceVar);
  representativeTracesPanel.setAdHocVariable(adHocFilters);
  representativeTracesPanel.setServiceVariable(serviceVar);

  const resourceDetailQuery = new SceneQueryRunner({
    datasource: CLICKHOUSE_DS,
    queries: [],
  });
  const resourceDetailPanel = new VizPanel({
    title: 'Resource signals',
    pluginId: 'timeseries',
    $data: resourceDetailQuery,
    fieldConfig: { defaults: { min: 0, custom: {} }, overrides: [] } as any,
    options: { legend: { showLegend: true } } as any,
  });
  const resourceDetailSection = new SceneFlexItem({
    height: 200,
    isHidden: true,
    body: resourceDetailPanel,
  });

  const saturationPanel = new SaturationPanel({
    datasource: CLICKHOUSE_DS,
    onViewSignals: (service, pod) => {
      resourceDetailQuery.setState({
        queries: [
          {
            refId: 'resourceDetail',
            datasource: CLICKHOUSE_DS,
            rawSql: buildResourceDetailSql(service, pod),
            format: 1,
            queryType: 'sql',
          } as any,
        ],
      });
      resourceDetailPanel.setState({ title: `Resource signals — ${service} · ${pod}` });
      resourceDetailSection.setState({ isHidden: false });
      resourceDetailQuery.runQueries();
    },
  });
  saturationPanel.setServiceVariable(serviceVar);
  saturationPanel.setAdHocVariable(adHocFilters);

  selectionState.addActivationHandler(() => {
    const sub = selectionState.subscribeToState((newState, prevState) => {
      if (newState.selection !== prevState.selection) {
        comparisonPanel.setSelection(newState.selection);
        representativeTracesPanel.setSelection(newState.selection);
        saturationPanel.setSelection(newState.selection);
      }
    });
    return () => sub.unsubscribe();
  });

  adHocFilters.addActivationHandler(() => {
    const sub = adHocFilters.subscribeToState((newState, prevState) => {
      if (newState.filters !== prevState.filters) {
        refreshHeatmapQuery();
        if (comparisonPanel.state.selection) {
          comparisonPanel.setSelection(comparisonPanel.state.selection);
        }
        if (representativeTracesPanel.state.selection) {
          representativeTracesPanel.setSelection(representativeTracesPanel.state.selection);
        }
        if (saturationPanel.state.selection) {
          saturationPanel.setSelection(saturationPanel.state.selection);
        }
      }
    });
    return () => sub.unsubscribe();
  });

  samplesVar.addActivationHandler(() => {
    const sub = samplesVar.subscribeToState((newState, prevState) => {
      if (newState.value !== prevState.value) {
        refreshHeatmapQuery();
      }
    });
    return () => sub.unsubscribe();
  });

  serviceVar.addActivationHandler(() => {
    const sub = serviceVar.subscribeToState((newState, prevState) => {
      if (newState.value !== prevState.value) {
        refreshHeatmapQuery();
        refreshStripQuery();
        if (comparisonPanel.state.selection) {
          comparisonPanel.setSelection(comparisonPanel.state.selection);
        }
        if (representativeTracesPanel.state.selection) {
          representativeTracesPanel.setSelection(representativeTracesPanel.state.selection);
        }
        if (saturationPanel.state.selection) {
          saturationPanel.setSelection(saturationPanel.state.selection);
        }
      }
    });
    return () => sub.unsubscribe();
  });

  const PANEL_TITLES: Record<string, string> = {
    latency: 'Trace Latency Heatmap',
    errors: 'Error Spans Heatmap',
  };

  const heatmapVizPanel = new VizPanel({
    title: PANEL_TITLES[currentMode()] ?? PANEL_TITLES.latency,
    pluginId: 'jordo-eventdeltas-panel',
    options: {
      yAxisScale: 'log',
      colorScheme: 'blues',
      colorMode: currentMode() === 'errors' ? 'errorRate' : 'count',
      yBuckets: 40,
    },
  });

  function modeFilterSql(mode: string): string {
    return mode === 'errors' ? `StatusCode = 'Error'` : '';
  }

  comparisonPanel.setModeFilter(modeFilterSql(currentMode()));
  representativeTracesPanel.setModeFilter(modeFilterSql(currentMode()));

  viewMode.addActivationHandler(() => {
    const sub = viewMode.subscribeToState((newState, prevState) => {
      if (newState.mode !== prevState.mode) {
        refreshHeatmapQuery();
        const opts = heatmapVizPanel.state.options as Record<string, unknown>;
        heatmapVizPanel.setState({
          title: PANEL_TITLES[newState.mode] ?? PANEL_TITLES.latency,
          options: { ...opts, colorMode: newState.mode === 'errors' ? 'errorRate' : 'count' },
        });
        comparisonPanel.setModeFilter(modeFilterSql(newState.mode));
        representativeTracesPanel.setModeFilter(modeFilterSql(newState.mode));
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

  const heatmapSection = new SceneFlexItem({
    height: 350,
    body: heatmapVizPanel,
  });
  const guidanceSection = new SceneFlexItem({
    minHeight: 110,
    body: new InvestigationGuidancePanel({
      title: 'Next best actions',
      summary: 'Use app navigation for page changes. Use panel actions only for data drilldowns.',
      kpis: [
        { label: 'View', value: view, color: 'blue' },
        { label: 'Flow', value: 'selection -> compare -> traces', color: 'purple' },
      ],
      actions: [],
    }),
  });
  const tracesSection = new SceneFlexItem({
    minHeight: 170,
    body: representativeTracesPanel,
  });
  const comparisonSection = new SceneFlexItem({
    minHeight: 400,
    body: comparisonPanel,
  });

  const stripSection = new SceneFlexItem({
    height: 190,
    body: new VizPanel({
      title: 'Infra saturation by service (max utilization)',
      pluginId: 'timeseries',
      $data: stripData,
      // No hard min/max: a fixed 0-100% axis wastes ~85% of the strip on empty
      // space below the pinned line and flattens variation. Auto-range hugs the
      // data band on both ends so spikes are legible; the % axis labels still
      // convey the absolute level.
      fieldConfig: {
        defaults: { unit: 'percentunit', custom: { fillOpacity: 8, lineWidth: 2, pointSize: 0 } },
        overrides: [],
      } as any,
      options: {
        legend: { showLegend: true, displayMode: 'list', placement: 'bottom' },
        tooltip: { mode: 'multi', sort: 'desc' },
      } as any,
    }),
  });
  const saturationSection = new SceneFlexItem({
    minHeight: 140,
    body: saturationPanel,
  });

  const orderedSections: SceneFlexItem[] =
    view === 'comparisons'
      ? [guidanceSection, comparisonSection, heatmapSection, stripSection, tracesSection, saturationSection, resourceDetailSection]
      : view === 'evidence'
        ? [guidanceSection, tracesSection, comparisonSection, heatmapSection, stripSection, saturationSection, resourceDetailSection]
        : [guidanceSection, heatmapSection, stripSection, tracesSection, comparisonSection, saturationSection, resourceDetailSection];

  return new EmbeddedScene({
    $timeRange: timeRange,
    $variables: new SceneVariableSet({
      variables: [serviceVar, samplesVar, adHocFilters],
    }),
    $data: heatmapQuery,
    body: new SceneFlexLayout({
      direction: 'column',
      children: orderedSections,
    }),
    controls: [
      viewMode,
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
