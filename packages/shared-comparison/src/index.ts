export { HeatmapSelectionEvent } from './types';
export { HeatmapSelectionClearedEvent } from './types';
export type { HeatmapSelection } from './types';
export { computeComparison } from './comparison';
export type { ValueDistribution, ComparisonResult, ComparisonTotals } from './comparison';
export { differenceLowerBound, isHighCardinality, MIN_VALUE_OCCURRENCES } from './comparisonStats';
export { buildComparisonSql } from './comparisonSql';
export type { ComparisonSqlOptions, ComparisonSqlColumn } from './comparisonSql';
export { SelectionState } from './SelectionState';
export type { SelectionStateState } from './SelectionState';
export { AttributeComparisonPanel } from './AttributeComparisonPanel';
export type { ComparisonAttribute, ComparisonPanelConfig } from './AttributeComparisonPanel';
export { RepresentativeTracesPanel } from './representativeTraces';
export type { RepresentativeTracesConfig } from './representativeTraces';
export { rankRepresentativeTraces } from './representativeTraceRanking';
export type { RepresentativeTraceRow } from './representativeTraceRanking';
export { buildFilterClause, filterExpressionForKey, escapeSql, quoteSqlString } from './sqlFilters';
export { InvestigationGuidancePanel } from './InvestigationGuidancePanel';
export { SATURATION_SIGNALS, MIN_SELECTION_SAMPLES, scoreSaturation } from './saturation';
export type { SaturationSignal, SignalKind, ResourceComparisonRow, SaturationScore } from './saturation';
export {
  DEFAULT_METRICS_TABLE,
  buildResourceSeriesSql,
  buildSaturationComparisonSql,
  buildResourceDetailSql,
} from './saturationSql';
export type { MsWindow } from './saturationSql';
export { SaturationPanel, parseComparisonFrames } from './SaturationPanel';
export type { SaturationPanelConfig } from './SaturationPanel';
