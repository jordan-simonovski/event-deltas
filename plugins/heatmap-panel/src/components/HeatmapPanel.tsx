import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { PanelProps, getFieldDisplayName, FieldType, LoadingState } from '@grafana/data';
import { getAppEvents, locationService, PanelDataErrorView } from '@grafana/runtime';
import { useTheme2 } from '@grafana/ui';
import { css } from '@emotion/css';
import { HeatmapOptions, HeatmapSelection, HeatmapSelectionClearedEvent, HeatmapSelectionEvent } from '../types';

interface Props extends PanelProps<HeatmapOptions> {}

// --- color ramps ---
const COLOR_RAMPS: Record<string, (t: number) => string> = {
  blues: (t) => {
    const r = Math.round(8 + (1 - t) * 238);
    const g = Math.round(48 + (1 - t) * 199);
    const b = Math.round(107 + (1 - t) * 145);
    return `rgb(${r},${g},${b})`;
  },
  greens: (t) => {
    const r = Math.round(0 + (1 - t) * 229);
    const g = Math.round(68 + (1 - t) * 177);
    const b = Math.round(27 + (1 - t) * 215);
    return `rgb(${r},${g},${b})`;
  },
  oranges: (t) => {
    const r = Math.round(127 + t * 128);
    const g = Math.round(39 + (1 - t) * 190);
    const b = Math.round(4 + (1 - t) * 232);
    return `rgb(${r},${g},${b})`;
  },
  reds: (t) => {
    const r = Math.round(103 + t * 152);
    const g = Math.round(0 + (1 - t) * 230);
    const b = Math.round(13 + (1 - t) * 230);
    return `rgb(${r},${g},${b})`;
  },
};

/** Green (t=0) -> yellow (t=0.5) -> red (t=1) for error-rate mode */
const ERROR_RATE_RAMP = (t: number): string => {
  if (t <= 0) {
    return 'rgb(76,175,80)';
  }
  if (t <= 0.5) {
    const f = t / 0.5;
    const r = Math.round(76 + f * (255 - 76));
    const g = Math.round(175 + f * (235 - 175));
    const b = Math.round(80 + f * (59 - 80));
    return `rgb(${r},${g},${b})`;
  }
  const f = (t - 0.5) / 0.5;
  const r = Math.round(255 - f * (255 - 211));
  const g = Math.round(235 - f * (235 - 47));
  const b = Math.round(59 - f * (59 - 47));
  return `rgb(${r},${g},${b})`;
};

const MARGIN = { top: 10, right: 10, bottom: 40, left: 60 };
const Y_AXIS_HEADROOM_FACTOR = 1.2;
const Y_AXIS_VISUAL_HEADROOM_PCT = 0.2;

interface RawSpan {
  time: number;
  duration: number;
  traceId: string;
  isError: boolean;
}

interface DragState {
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
}

interface ContextMenuState {
  x: number;
  y: number;
  payload: HeatmapSelection;
}

export const HeatmapPanel: React.FC<Props> = ({ options, data, width, height, timeRange, onChangeTimeRange, id }) => {
  const theme = useTheme2();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [selection, setSelection] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  // Extract raw spans from data frames
  const rawSpans = useMemo<RawSpan[]>(() => {
    const spans: RawSpan[] = [];
    for (const frame of data.series) {
      let timeIdx = -1;
      let durationIdx = -1;
      let traceIdIdx = -1;
      let errorIdx = -1;

      for (let i = 0; i < frame.fields.length; i++) {
        const f = frame.fields[i];
        const name = getFieldDisplayName(f, frame).toLowerCase();
        if (f.type === FieldType.time || name === 'timestamp') {
          timeIdx = i;
        } else if (name === 'duration' || name === 'duration_ms' || name === 'durationnano') {
          durationIdx = i;
        } else if (name === 'traceid' || name === 'trace_id') {
          traceIdIdx = i;
        } else if (name === 'iserror' || name === 'is_error') {
          errorIdx = i;
        }
      }

      if (timeIdx < 0 || durationIdx < 0) {
        continue;
      }

      const timeField = frame.fields[timeIdx];
      const durField = frame.fields[durationIdx];
      const traceField = traceIdIdx >= 0 ? frame.fields[traceIdIdx] : null;
      const errorField = errorIdx >= 0 ? frame.fields[errorIdx] : null;

      for (let i = 0; i < frame.length; i++) {
        let timeVal = timeField.values[i];
        if (typeof timeVal === 'string') {
          timeVal = new Date(timeVal).getTime();
        } else if (typeof timeVal === 'number' && timeVal > 1e15) {
          timeVal = timeVal / 1e6;
        }

        let dur = durField.values[i];
        if (typeof dur === 'number' && dur > 1e9) {
          dur = dur / 1e6;
        }

        const errVal = errorField ? errorField.values[i] : false;

        spans.push({
          time: timeVal,
          duration: Math.max(dur, 0.01),
          traceId: traceField ? String(traceField.values[i]) : '',
          isError: errVal === true || errVal === 1 || errVal === '1',
        });
      }
    }
    return spans;
  }, [data.series]);

  // Compute axis ranges
  const { minTime, maxTime, minDur, maxDur } = useMemo(() => {
    if (rawSpans.length === 0) {
      return { minTime: 0, maxTime: 1, minDur: 1, maxDur: 1000 };
    }
    let mnT = Infinity, mxT = -Infinity, mnD = Infinity, mxD = -Infinity;
    for (const s of rawSpans) {
      if (s.time < mnT) { mnT = s.time; }
      if (s.time > mxT) { mxT = s.time; }
      if (s.duration < mnD) { mnD = s.duration; }
      if (s.duration > mxD) { mxD = s.duration; }
    }
    if (mnD < 0.1) { mnD = 0.1; }
    return { minTime: mnT, maxTime: mxT, minDur: mnD, maxDur: mxD * Y_AXIS_HEADROOM_FACTOR };
  }, [rawSpans]);

  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;

  const isLog = options.yAxisScale === 'log';

  const timeToX = useCallback(
    (t: number) => MARGIN.left + ((t - minTime) / (maxTime - minTime || 1)) * plotW,
    [minTime, maxTime, plotW]
  );
  const durToY = useCallback(
    (d: number) => {
      const usablePlotH = plotH * (1 - Y_AXIS_VISUAL_HEADROOM_PCT);
      const bottomY = MARGIN.top + plotH;
      if (isLog) {
        const logMin = Math.log10(Math.max(minDur, 0.1));
        const logMax = Math.log10(maxDur);
        const logD = Math.log10(Math.max(d, 0.1));
        return bottomY - ((logD - logMin) / (logMax - logMin || 1)) * usablePlotH;
      }
      return bottomY - ((d - minDur) / (maxDur - minDur || 1)) * usablePlotH;
    },
    [isLog, minDur, maxDur, plotH]
  );

  const xToTime = useCallback(
    (x: number) => minTime + ((x - MARGIN.left) / plotW) * (maxTime - minTime),
    [minTime, maxTime, plotW]
  );
  const yToDur = useCallback(
    (y: number) => {
      const usablePlotH = plotH * (1 - Y_AXIS_VISUAL_HEADROOM_PCT);
      const frac = (MARGIN.top + plotH - y) / (usablePlotH || 1);
      if (isLog) {
        const logMin = Math.log10(Math.max(minDur, 0.1));
        const logMax = Math.log10(maxDur);
        return Math.pow(10, logMin + frac * (logMax - logMin));
      }
      return minDur + frac * (maxDur - minDur);
    },
    [isLog, minDur, maxDur, plotH]
  );

  // Bucket and render heatmap
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) { return; }
    const ctx = canvas.getContext('2d');
    if (!ctx) { return; }

    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);

    if (rawSpans.length === 0) {
      ctx.fillStyle = theme.colors.text.secondary;
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No data', width / 2, height / 2);
      return;
    }

    const xBuckets = Math.max(Math.floor(plotW / 4), 10);
    const yBuckets = options.yBuckets || 40;
    const gridTotal = new Float64Array(xBuckets * yBuckets);
    const gridError = new Float64Array(xBuckets * yBuckets);

    const logMin = Math.log10(Math.max(minDur, 0.1));
    const logMax = Math.log10(maxDur);

    for (const s of rawSpans) {
      const xFrac = (s.time - minTime) / (maxTime - minTime || 1);
      const y = durToY(s.duration);
      const yFrac = (MARGIN.top + plotH - y) / plotH;

      const xi = Math.min(Math.floor(xFrac * xBuckets), xBuckets - 1);
      const yi = Math.min(Math.floor(yFrac * yBuckets), yBuckets - 1);
      if (xi >= 0 && yi >= 0) {
        const idx = yi * xBuckets + xi;
        gridTotal[idx]++;
        if (s.isError) {
          gridError[idx]++;
        }
      }
    }

    const isErrorRate = options.colorMode === 'errorRate';

    let maxCount = 0;
    if (!isErrorRate) {
      for (let i = 0; i < gridTotal.length; i++) {
        if (gridTotal[i] > maxCount) { maxCount = gridTotal[i]; }
      }
    }

    const colorFn = isErrorRate ? ERROR_RATE_RAMP : (COLOR_RAMPS[options.colorScheme] || COLOR_RAMPS.blues);
    const cellW = plotW / xBuckets;
    const cellH = plotH / yBuckets;

    for (let yi = 0; yi < yBuckets; yi++) {
      for (let xi = 0; xi < xBuckets; xi++) {
        const idx = yi * xBuckets + xi;
        const total = gridTotal[idx];
        if (total === 0) { continue; }

        let t: number;
        if (isErrorRate) {
          t = gridError[idx] / total;
        } else {
          t = Math.log1p(total) / Math.log1p(maxCount);
        }

        ctx.fillStyle = colorFn(t);
        const px = MARGIN.left + xi * cellW;
        const py = MARGIN.top + plotH - (yi + 1) * cellH;
        ctx.fillRect(px, py, cellW + 0.5, cellH + 0.5);
      }
    }

    // Axes
    ctx.strokeStyle = theme.colors.text.secondary;
    ctx.lineWidth = 1;

    ctx.beginPath();
    ctx.moveTo(MARGIN.left, MARGIN.top + plotH);
    ctx.lineTo(MARGIN.left + plotW, MARGIN.top + plotH);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(MARGIN.left, MARGIN.top);
    ctx.lineTo(MARGIN.left, MARGIN.top + plotH);
    ctx.stroke();

    ctx.fillStyle = theme.colors.text.secondary;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    const xTicks = 5;
    for (let i = 0; i <= xTicks; i++) {
      const t = minTime + (i / xTicks) * (maxTime - minTime);
      const x = timeToX(t);
      const d = new Date(t);
      ctx.fillText(d.toLocaleTimeString(), x, MARGIN.top + plotH + 14);
      ctx.beginPath();
      ctx.moveTo(x, MARGIN.top + plotH);
      ctx.lineTo(x, MARGIN.top + plotH + 4);
      ctx.stroke();
    }

    ctx.textAlign = 'right';
    const yTicks = 5;
    for (let i = 0; i <= yTicks; i++) {
      let durVal: number;
      if (isLog) {
        durVal = Math.pow(10, logMin + (i / yTicks) * (logMax - logMin));
      } else {
        durVal = minDur + (i / yTicks) * (maxDur - minDur);
      }
      const y = durToY(durVal);
      let label: string;
      if (durVal >= 1000) {
        label = (durVal / 1000).toFixed(1) + 's';
      } else {
        label = durVal.toFixed(durVal < 1 ? 2 : 0) + 'ms';
      }
      ctx.fillText(label, MARGIN.left - 6, y + 3);
      ctx.beginPath();
      ctx.moveTo(MARGIN.left - 3, y);
      ctx.lineTo(MARGIN.left, y);
      ctx.stroke();
    }

    ctx.fillStyle = theme.colors.text.primary;
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Time', MARGIN.left + plotW / 2, height - 4);

    ctx.save();
    ctx.translate(14, MARGIN.top + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('Duration', 0, 0);
    ctx.restore();
  }, [rawSpans, width, height, options, theme, plotW, plotH, minTime, maxTime, minDur, maxDur, isLog, timeToX, durToY]);

  // Draw selection overlay
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas) { return; }
    const ctx = canvas.getContext('2d');
    if (!ctx) { return; }

    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);

    const rect = drag
      ? { x1: drag.startX, y1: drag.startY, x2: drag.currentX, y2: drag.currentY }
      : selection;

    if (!rect) { return; }

    const x = Math.min(rect.x1, rect.x2);
    const y = Math.min(rect.y1, rect.y2);
    const w = Math.abs(rect.x2 - rect.x1);
    const h = Math.abs(rect.y2 - rect.y1);

    ctx.fillStyle = 'rgba(255, 193, 7, 0.25)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(255, 193, 7, 0.8)';
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
  }, [drag, selection, width, height]);

  // --- Resolve selection into payload ---
  const resolveSelection = useCallback(
    (x1: number, y1: number, x2: number, y2: number): HeatmapSelection => {
      const fromTime = xToTime(Math.min(x1, x2));
      const toTime = xToTime(Math.max(x1, x2));
      const maxLatency = yToDur(Math.min(y1, y2));
      const minLatency = yToDur(Math.max(y1, y2));

      const matchingTraceIds: string[] = [];
      let matchCount = 0;
      const seen = new Set<string>();

      for (const s of rawSpans) {
        if (s.time >= fromTime && s.time <= toTime && s.duration >= minLatency && s.duration <= maxLatency) {
          matchCount++;
          if (s.traceId && !seen.has(s.traceId)) {
            seen.add(s.traceId);
            matchingTraceIds.push(s.traceId);
          }
        }
      }

      return {
        timeRange: { from: fromTime, to: toTime },
        latencyRange: { min: minLatency, max: maxLatency },
        traceIds: matchingTraceIds,
        spanCount: matchCount,
      };
    },
    [rawSpans, xToTime, yToDur]
  );

  // --- Mouse handlers ---
  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Dismiss context menu on any new click
      setContextMenu(null);

      const rect = overlayRef.current?.getBoundingClientRect();
      if (!rect) { return; }
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (x < MARGIN.left || x > MARGIN.left + plotW || y < MARGIN.top || y > MARGIN.top + plotH) {
        return;
      }
      setDrag({ startX: x, startY: y, currentX: x, currentY: y });
      setSelection(null);
    },
    [plotW, plotH]
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!drag) { return; }
      const rect = overlayRef.current?.getBoundingClientRect();
      if (!rect) { return; }
      const x = Math.max(MARGIN.left, Math.min(e.clientX - rect.left, MARGIN.left + plotW));
      const y = Math.max(MARGIN.top, Math.min(e.clientY - rect.top, MARGIN.top + plotH));
      setDrag((prev) => (prev ? { ...prev, currentX: x, currentY: y } : null));
    },
    [drag, plotW, plotH]
  );

  const onMouseUp = useCallback(() => {
    if (!drag) { return; }

    const x1 = Math.min(drag.startX, drag.currentX);
    const x2 = Math.max(drag.startX, drag.currentX);
    const y1 = Math.min(drag.startY, drag.currentY);
    const y2 = Math.max(drag.startY, drag.currentY);

    // Require minimum drag distance
    if (x2 - x1 < 5 && y2 - y1 < 5) {
      setDrag(null);
      setSelection(null);
      getAppEvents().publish(new HeatmapSelectionClearedEvent(null));
      return;
    }

    setSelection({ x1, y1, x2, y2 });
    setDrag(null);

    const payload = resolveSelection(x1, y1, x2, y2);

    // Position context menu at top-right corner of selection box
    const menuX = Math.min(x2 + 4, width - 200);
    const menuY = Math.max(y1, MARGIN.top);

    setContextMenu({ x: menuX, y: menuY, payload });
  }, [drag, resolveSelection, width]);

  const onMouseLeave = useCallback(() => {
    if (drag) {
      onMouseUp();
    }
  }, [drag, onMouseUp]);

  // --- Context menu actions ---
  const handleAnalyze = useCallback(() => {
    if (!contextMenu) { return; }
    getAppEvents().publish(new HeatmapSelectionEvent(contextMenu.payload));
    setContextMenu(null);
  }, [contextMenu]);

  const appRootPath = useCallback(() => {
    const path = locationService.getLocation().pathname ?? window.location.pathname;
    const match = path.match(/^\/a\/[^/]+/);
    return match ? match[0] : null;
  }, []);

  const handleOpenExplorer = useCallback(() => {
    if (!contextMenu) { return; }
    getAppEvents().publish(new HeatmapSelectionEvent(contextMenu.payload));
    const root = appRootPath();
    if (root) {
      locationService.push(`${root}/explorer`);
    }
    setContextMenu(null);
  }, [appRootPath, contextMenu]);

  const handleZoom = useCallback(() => {
    if (!contextMenu) { return; }
    const { from, to } = contextMenu.payload.timeRange;
    onChangeTimeRange({ from, to });
    setContextMenu(null);
    setSelection(null);
  }, [contextMenu, onChangeTimeRange]);

  const handleViewTrace = useCallback(() => {
    if (!contextMenu || contextMenu.payload.traceIds.length !== 1) { return; }
    const traceId = contextMenu.payload.traceIds[0];
    // Navigate to Grafana Explore with the trace ID
    locationService.push(`/explore?left={"queries":[{"refId":"A","queryType":"traceql","query":"${traceId}"}],"range":{"from":"${contextMenu.payload.timeRange.from}","to":"${contextMenu.payload.timeRange.to}"}}`);
    setContextMenu(null);
  }, [contextMenu]);

  const dismissMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const clearSelection = useCallback(() => {
    setContextMenu(null);
    setSelection(null);
    getAppEvents().publish(new HeatmapSelectionClearedEvent(null));
  }, []);

  const singleTrace = contextMenu && contextMenu.payload.traceIds.length === 1;

  if (data.state === LoadingState.Error) {
    return (
      <PanelDataErrorView panelId={id} data={data} needsStringField={false} needsNumberField={false} needsTimeField={false} />
    );
  }

  return (
    <div
      className={css`
        position: relative;
        width: ${width}px;
        height: ${height}px;
        cursor: crosshair;
      `}
    >
      <canvas
        ref={canvasRef}
        className={css`
          position: absolute;
          top: 0;
          left: 0;
        `}
      />
      <canvas
        ref={overlayRef}
        className={css`
          position: absolute;
          top: 0;
          left: 0;
        `}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
      />

      {/* Context menu */}
      {contextMenu && (
        <div
          className={css`
            position: absolute;
            top: ${contextMenu.y}px;
            left: ${contextMenu.x}px;
            z-index: 100;
            background: ${theme.colors.background.primary};
            border: 1px solid ${theme.colors.border.medium};
            border-radius: ${theme.shape.radius.default};
            box-shadow: ${theme.shadows.z3};
            min-width: 180px;
            padding: 4px 0;
            font-size: 13px;
          `}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div
            className={css`
              padding: 6px 12px;
              color: ${theme.colors.text.secondary};
              font-size: 11px;
              border-bottom: 1px solid ${theme.colors.border.weak};
              margin-bottom: 2px;
            `}
          >
            {contextMenu.payload.spanCount} span{contextMenu.payload.spanCount !== 1 ? 's' : ''} selected
            {contextMenu.payload.traceIds.length > 0 &&
              ` (${contextMenu.payload.traceIds.length} trace${contextMenu.payload.traceIds.length !== 1 ? 's' : ''})`}
          </div>

          <MenuItem
            icon="M3 3h18v2H3V3zm0 8h18v2H3v-2zm0 8h18v2H3v-2z"
            label="Analyze selection"
            onClick={handleAnalyze}
            theme={theme}
          />
          <MenuItem
            icon="M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 .34-.03.67-.08 1h2.02c.03-.33.06-.66.06-1 0-4.42-3.58-8-8-8zM6.08 11H4.06c-.03.33-.06.66-.06 1 0 4.42 3.58 8 8 8v3l4-4-4-4v3c-3.31 0-6-2.69-6-6 0-.34.03-.67.08-1z"
            label="Open explorer view"
            onClick={handleOpenExplorer}
            theme={theme}
          />
          <MenuItem
            icon="M15 3l6 6-6 6V3zM9 21l-6-6 6-6v12z"
            label="Zoom to time range"
            onClick={handleZoom}
            theme={theme}
          />
          {singleTrace && (
            <MenuItem
              icon="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"
              label={`View trace ${contextMenu.payload.traceIds[0].slice(0, 8)}...`}
              onClick={handleViewTrace}
              theme={theme}
            />
          )}

          <div
            className={css`
              border-top: 1px solid ${theme.colors.border.weak};
              margin-top: 2px;
            `}
          >
            <MenuItem
              icon="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10c3.7 0 6.91-2.01 8.64-5H18.3c-1.38 1.7-3.49 2.8-5.86 2.8-4.14 0-7.5-3.36-7.5-7.5s3.36-7.5 7.5-7.5c2.2 0 4.18.95 5.55 2.45L15 10h7V3l-2.82 2.82A9.944 9.944 0 0012 2z"
              label="Reset selection"
              onClick={clearSelection}
              theme={theme}
              subtle
            />
            <MenuItem
              icon="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"
              label="Dismiss"
              onClick={dismissMenu}
              theme={theme}
              subtle
            />
          </div>
        </div>
      )}
    </div>
  );
};

// --- Menu item component ---
function MenuItem({
  icon,
  label,
  onClick,
  theme,
  subtle,
}: {
  icon: string;
  label: string;
  onClick: () => void;
  theme: ReturnType<typeof useTheme2>;
  subtle?: boolean;
}) {
  return (
    <div
      className={css`
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        cursor: pointer;
        color: ${subtle ? theme.colors.text.secondary : theme.colors.text.primary};
        &:hover {
          background: ${theme.colors.action.hover};
        }
      `}
      onClick={onClick}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d={icon} />
      </svg>
      <span>{label}</span>
    </div>
  );
}
