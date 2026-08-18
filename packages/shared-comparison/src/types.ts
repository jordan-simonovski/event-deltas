import { BusEventWithPayload } from '@grafana/data';

export interface HeatmapSelection {
  timeRange: { from: number; to: number };
  latencyRange?: { min: number; max: number };
  traceIds?: string[];
  spanCount?: number;
}

export class HeatmapSelectionEvent extends BusEventWithPayload<HeatmapSelection> {
  static type = 'event-deltas-selection';
}

export class HeatmapSelectionClearedEvent extends BusEventWithPayload<null> {
  static type = 'event-deltas-selection-clear';
}
