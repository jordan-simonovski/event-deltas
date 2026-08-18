import { EVENT_DELTAS_APP_ID } from '../constants';

function encodePart(v: string): string {
  return encodeURIComponent(v);
}

export function heatmapTraceRoute(traceId: string): string {
  return `/a/${EVENT_DELTAS_APP_ID}/trace/${encodePart(traceId)}`;
}

export function heatmapExplorerRoute(): string {
  return `/a/${EVENT_DELTAS_APP_ID}/explorer`;
}
