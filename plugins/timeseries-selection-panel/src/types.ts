import { BusEventWithPayload } from '@grafana/data';

export interface TimeseriesSelectionOptions {
  lineColor: string;
  fillOpacity: number;
  thresholdValue?: number;
  thresholdColor: string;
  yAxisLabel: string;
}

/** Matches the shared-comparison HeatmapSelection interface (latency fields optional). */
export interface TimeseriesSelection {
  timeRange: { from: number; to: number };
}

/**
 * Published on the same bus channel as HeatmapSelectionEvent ('event-deltas-selection')
 * so that SelectionState in shared-comparison picks it up identically.
 */
export class TimeseriesSelectionEvent extends BusEventWithPayload<TimeseriesSelection> {
  static type = 'event-deltas-selection';
}

export class TimeseriesSelectionClearedEvent extends BusEventWithPayload<null> {
  static type = 'event-deltas-selection-clear';
}
