# Saturation via Wide Events — Design

**Date:** 2026-07-03 · **Branch:** `feat/saturation-experiments` · **Status:** awaiting review

## Problem

The heatmap/bubble-up UX explains *application* behaviour well: select a blob of slow or
failing spans, rank the attributes that distinguish them from baseline. It says nothing
about whether those spans were slow *because the infrastructure underneath was saturated*,
or conversely which application behaviours are driving saturation. Infra telemetry is
periodic per-resource samples, not request-scoped events, so it doesn't fit the existing
span-attribute comparison directly — and today the stack ingests no metrics at all
(`docker/otel-collector-config.yml` pipelines: traces only).

## Hypothesis

**Saturation does not need a separate metrics product.** Raw OTel metric datapoints,
ingested as-is into ClickHouse, are already wide-event-shaped: every row carries its full
`ResourceAttributes` map alongside a value and timestamp. That means the product's core
mental model — *select a region, compare it against baseline, rank what's different* —
extends to infra with **no pre-aggregation and no new services**, using query-time
correlation on two keys the data already shares with spans:

1. **Resource identity** — `ResourceAttributes['service.name']` (v1), later
   `k8s.pod.name` / `host.name` as span resource attributes are enriched.
2. **Time** — the selection window vs. the surrounding baseline window.

If this holds, users get two natural insights inside the existing workbench:

- **Forward (selection → infra):** "for the spans you selected, these resources were
  saturated relative to baseline" — ranked cards, same grammar as bubble-up.
- **Ambient (infra → selection):** a slim saturation strip aligned with the heatmap's
  time axis, so infra pressure is visible *before* the user selects, guiding where to look.

## Approaches considered

**A. Query-time correlation over raw exporter tables — recommended.**
Enable the collector's metrics pipeline; the ClickHouse exporter creates
`otel_metrics_gauge` (and siblings) with `ResourceAttributes`, `MetricName`, `Value`,
`TimeUnix`. All derivation (per-resource quantiles, selection-vs-baseline deltas,
per-bucket series) is plain SQL, built in TS exactly like the existing builders in
`bubblesScene.ts` / `AttributeComparisonPanel.tsx`. Zero new infra, fully consistent
with the wide-events philosophy.

**B. Materialized view → normalized `infra_snapshots` table.**
One row per (resource, 10s interval) with a `Map(String, Float64)` of signal values —
literally "resource snapshot wide events", enabling byte-for-byte reuse of the bubble-up
engine over resource attributes. Better query ergonomics and cost at scale, but adds a
schema-management burden now for a scale problem we don't have.
**This is the named upgrade path for A, not the starting point.**

**C. Dedicated ingestion/aggregation service (Go).**
Rejected. Over-engineered for a problem ClickHouse aggregation already solves; violates
the lean-on-wide-events principle by inventing a metrics pipeline.

**Decision: A, with B as the ceiling upgrade** (trigger: raw-datapoint scans measurably
hurting workbench latency at real data volumes).

## Design

### 1. Data path (demo/dev stack)

- **Collector** (`docker/otel-collector-config.yml`): add a `metrics` pipeline —
  `otlp` receiver is already listening; add `metrics_table_name` to the ClickHouse
  exporter. Verify exact table/column names against the exporter version pinned in the
  docker image at implementation time.
- **trace-generator**: emit OTLP gauges per synthetic service (resource attrs:
  `service.name`, `k8s.pod.name`): `cpu.utilization`, `memory.utilization`,
  `db.pool.utilization`, `queue.depth`. Scenario-correlated so the feature is
  demonstrable end-to-end: S5 (auth memory leak) ramps `memory.utilization` on
  `pod-abc-7/8`; S8 (saturated Elasticsearch) pins `cpu.utilization`/`queue.depth`
  on `search-service`. Baseline services idle around 20–50% with noise.
- **Join key, v1:** `ServiceName` (spans) ↔ `ResourceAttributes['service.name']`
  (metrics). Pod/host granularity rides along in the metric's resource attrs for
  *display and ranking*, without requiring span-side enrichment yet.
  <!-- ponytail: service-level join misses infra not owned by a service (shared DB
       host); upgrade path is adding host.name/k8s.pod.name to span resources. -->

### 2. Signal registry

A small hardcoded list in `packages/shared-comparison` — `{ metricName, kind:
'utilization' | 'counter', label }`. Utilization signals are 0–1 and comparable in
percentage points; counters (queue depth) are normalized against their own baseline.
No config surface in v1; config override is the obvious later step.

### 3. Query + scoring layer (`packages/shared-comparison/src/saturation*.ts`)

- `buildResourceSeriesSql(timeRange, services, table)` — per (service, pod, metric,
  time bucket) average value; feeds the saturation strip.
- `buildSaturationComparisonSql(selectionWindow, timeRange, services, table)` — one
  pass with `quantileIf`: per (resource, metric) → `p95_selection`, `p95_baseline`
  (baseline = panel range excluding the selection window, mirroring the existing
  baseline-predicate pattern in `AttributeComparisonPanel.tsx:182-213`).
- **Scoring (pure function, TDD'd):** for utilization signals,
  `score = p95_selection − p95_baseline` (percentage points), rank descending, drop
  score ≤ 0 — same directional, selection-first semantics as `computeComparison`.
  Counters use relative delta. <!-- ponytail: p95-delta scoring; upgrade is
  effect-size normalization (z-score) if noisy signals mis-rank. -->
- SQL string-building follows the existing template style and reuses
  `sqlFilters.ts` escaping helpers.

### 4. UX (heatmap-app workbench)

Per `docs/scenes-ux-conventions.md` (≥2 next actions everywhere, actionable empty
states, theme tokens):

- **Infra saturation section** in the evidence area of `bubblesScene`: on selection,
  ranked resource cards — *"search-service · pod-3 · CPU — 93% during selection vs 41%
  baseline (+52)"*. Card actions: (1) filter workbench to that service/pod (existing
  AdHoc filter mechanism), (2) open a resource timeseries drawer (stock timeseries
  panel scoped to that resource's signals).
- **Saturation strip**: a slim (~90px) stock timeseries `VizPanel` aligned under the
  heatmap, showing max utilization per bucket across in-view services, driven by a
  `SceneQueryRunner`. No custom viz.
- **Empty state**: "No infra metrics found for this window" + link to setup docs —
  the feature degrades to invisible-but-explained when metrics aren't ingested.

### 5. Testing

- Jest: scoring function (ranking, direction, zero/negative filtering), SQL builder
  snapshots, signal normalization — alongside the existing `*.test.js` suites.
- End-to-end: docker stack, trigger S5/S8, verify cards and strip respond; one
  Playwright smoke if cheap, otherwise manual checklist in the PR.

## Error handling

- Metrics tables absent / query fails → section renders its empty state; never blocks
  the span-side workbench (saturation queries are parallel and non-fatal).
- Selection window too small for stable p95 → fall back to max; label the card.

## Work division (implementation phases × best-suited model)

| Phase | Work | Model | Why |
|---|---|---|---|
| 1a | Collector metrics pipeline, docker wiring, schema verification | Haiku | Mechanical config; verifiable by rows appearing in the metrics table |
| 1b | trace-generator OTLP gauge emission, scenario correlation (Go) | Sonnet | Multi-scenario but pattern-following Go work |
| 2 | Saturation SQL builders + scoring in shared-comparison (TDD) | Fable/Opus | Load-bearing correlation semantics and schema decisions |
| 3 | Workbench integration: cards section, strip, drawer, empty states | Sonnet, Opus review | Scenes plumbing following existing patterns; review guards UX conventions |
| 4 | Docs, changeset, PR polish | Haiku | Mechanical |

Phases 1 and 2 run in parallel (2 builds against the documented exporter schema as a
fixture); 3 depends on both; 4 trails.

## Out of scope (deliberately)

- Standalone saturation-first landing page (the ambient strip covers discovery in v1).
- Configurable signal registry / user-defined metrics.
- Non-service-scoped infra (shared DB hosts) — needs span-side resource enrichment.
- Materialized snapshot table (Approach B) — named upgrade, not v1.
