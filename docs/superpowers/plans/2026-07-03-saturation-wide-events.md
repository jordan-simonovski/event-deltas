# Saturation via Wide Events — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Bubbles workbench so a heatmap selection also answers "was the infrastructure saturated?" — ranked resource cards on selection, plus an ambient saturation strip under the heatmap — via query-time SQL over raw OTel metric rows in ClickHouse. No pre-aggregation, no new services.

**Architecture:** Enable the collector's metrics pipeline (config only) → make trace-generator emit scenario-correlated OTLP gauges (S5 memory saturation is *episodic*, with 503 bursts concentrated inside episodes) → pure TS scoring + SQL builders in `packages/shared-comparison` (TDD) → a `SaturationPanel` scene object and a stock-timeseries strip wired into `bubblesScene.ts`. Correlation key is `ServiceName` (spans) ↔ `ResourceAttributes['service.name']` (metrics) + time window; pod granularity rides on the metric side only.

**Tech Stack:** Go 1.25 (otel-go v1.43 metric SDK + otlpmetricgrpc), TypeScript strict (@grafana/scenes), ClickHouse SQL (hand-built strings — house style), jest (`.test.ts` — jest already matches it), docker compose stack.

## Global Constraints

- **Read these skills first:** `.claude/skills/heatmap-saturation-campaign/SKILL.md` (the campaign this plan implements — its gates are law), and per task where noted: `heatmap-build-and-env`, `heatmap-validation-and-qa`, `heatmap-change-control`.
- Branch: `feat/saturation-experiments` (already checked out). All commands run from repo root.
- **NEVER `git add -A` or `git add .`** — the repo contains deliberately-uncommitted artifacts (`docs/superpowers/`, possibly `.claude/`). Stage ONLY the exact paths each commit step lists. Never commit `docker/.env.slo` or any `dist/` change.
- All tests in **TypeScript** (`.test.ts`) on the TS side; jest `testMatch` already covers it (`plugins/heatmap-app/.config/jest.config.js:19-23`).
- All analysis SQL is hand-built TS strings. **Never** use `${filters:raw}` or Grafana variable interpolation in SQL (ClickHouse datasource parser bug — `plugins/heatmap-app/src/pages/Bubbles/bubblesScene.ts:29-30`).
- Theme tokens only in UI (`useStyles2`); raw colors only for semantic severity. Every new UI surface: ≥2 meaningful next actions, actionable empty states (`docs/scenes-ux-conventions.md`).
- Demo security posture (no auth, anonymous-Admin Grafana, open ClickHouse) is **intentional** — do not "fix" it while in there.
- Metrics table name is assumed `otel_metrics_gauge`; Task 1 verifies against the running exporter (image is `:latest`). If DESCRIBE shows different names, change `DEFAULT_METRICS_TABLE` in Task 5 once — every other reference flows from it.
- Node ≥ 22, Go 1.25, docker stack via `make up` (see `heatmap-build-and-env` if the stack misbehaves; note: `make up`'s version cache-bust sed is a known no-op — after plugin rebuilds, `docker compose -f docker/docker-compose.yml restart grafana` and hard-refresh the browser).

## File Map

| File | Action | Responsibility |
|---|---|---|
| `docker/otel-collector-config.yml` | Modify | metrics pipeline → ClickHouse exporter |
| `trace-generator/metrics.go` | Create | signal synthesis (pure) + OTLP gauge emission |
| `trace-generator/metrics_test.go` | Create | Go tests for pure synthesis functions |
| `trace-generator/main.go` | Modify | wire metric emitters; episodic S5 503s |
| `trace-generator/main_test.go` | Modify | weighted-average rate assertion |
| `packages/shared-comparison/src/saturation.ts` | Create | signal registry + scoring (pure) |
| `packages/shared-comparison/src/saturationSql.ts` | Create | SQL builders |
| `packages/shared-comparison/src/SaturationPanel.tsx` | Create | cards scene object + parse helper |
| `packages/shared-comparison/src/index.ts` | Modify | exports |
| `plugins/heatmap-app/src/saturation.test.ts` | Create | scorer tests |
| `plugins/heatmap-app/src/saturationSql.test.ts` | Create | SQL builder tests |
| `plugins/heatmap-app/src/saturationParse.test.ts` | Create | frame-parse tests |
| `plugins/heatmap-app/src/components/Bubbles/SaturationPanel.ts` | Create | re-export shim (house pattern) |
| `plugins/heatmap-app/src/pages/Bubbles/bubblesScene.ts` | Modify | strip + sections + wiring |
| `.changeset/saturation-wide-events.md` | Create | release note |

---

### Task 1: Collector metrics pipeline (campaign P0 + P1)

**Files:**
- Modify: `docker/otel-collector-config.yml`

**Interfaces:**
- Produces: ClickHouse tables `otel_metrics_*` (created by the exporter). Task 5's SQL is written against `otel_metrics_gauge` with columns `ResourceAttributes Map`, `MetricName`, `Value Float64`, `TimeUnix DateTime64(9)`.

- [ ] **Step 1: Preflight (campaign P0 — read-only)**

Run each; stop and consult the named skill if an expectation fails:

```bash
docker compose -f docker/docker-compose.yml ps
# Expect: postgres, clickhouse-server, otel-collector, trace-generator, grafana, slo-control-plane, slo-evaluator all Up. If not: heatmap-build-and-env.

docker exec clickhouse-server clickhouse-client --query "SHOW TABLES LIKE 'otel_metrics%'"
# Expect: empty (no metrics tables yet). If tables exist: P1 already started — audit git log docker/ and resume at first unmet gate.

docker exec clickhouse-server clickhouse-client --query "SELECT count() FROM otel_traces WHERE Timestamp > now() - INTERVAL 1 MINUTE"
# Expect: 3000–15000 (spans/min). If ~0: make logs-generator / make logs-collector.

docker exec clickhouse-server clickhouse-client --query "SELECT groupUniqArrayArray(mapKeys(ResourceAttributes)) FROM otel_traces WHERE Timestamp > now() - INTERVAL 5 MINUTE"
# Expect: ['service.name','service.version'] — NO pod/host keys. This is why the join key is ServiceName.
```

- [ ] **Step 2: Record the collector version and check exporter config keys**

```bash
docker exec otel-collector /otelcol-contrib --version
```

Record the version string (goes in the PR body later). Check the `clickhouseexporter` README for that version tag (`github.com/open-telemetry/opentelemetry-collector-contrib`, path `exporter/clickhouseexporter/README.md`): confirm whether metrics tables are configured via `metrics_table_name:` (prefix; tables become `<prefix>_gauge` etc.) or a newer per-type key. The edit below assumes `metrics_table_name` — adjust to what the README for YOUR version says.

- [ ] **Step 3: Edit the collector config**

Replace the full contents of `docker/otel-collector-config.yml` with:

```yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

processors:
  batch:
    timeout: 1s
    send_batch_size: 1024

exporters:
  clickhouse:
    endpoint: tcp://clickhouse-server:9000?dial_timeout=10s
    database: default
    traces_table_name: otel_traces
    logs_table_name: otel_logs
    metrics_table_name: otel_metrics
    create_schema: true

service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [clickhouse]
    metrics:
      receivers: [otlp]
      processors: [batch]
      exporters: [clickhouse]
```

- [ ] **Step 4: Restart the collector and check logs**

```bash
docker compose -f docker/docker-compose.yml restart otel-collector
docker compose -f docker/docker-compose.yml logs otel-collector --tail 30
```

Expected: no exporter errors. Crash-loop → YAML error. Config-key errors → your exporter version wants different keys (Step 2).

- [ ] **Step 5: GATE P1 — tables exist, capture schema**

```bash
docker exec clickhouse-server clickhouse-client --query "SHOW TABLES LIKE 'otel_metrics%'"
```

Expected: the gauge/sum/histogram family (e.g. `otel_metrics_gauge`, `otel_metrics_sum`, ...). If empty AND logs are clean: some exporter versions create schema on first write — proceed to Task 2 and re-check this gate after the first gauge lands; if still empty then, the pipeline is wrong.

```bash
docker exec clickhouse-server clickhouse-client --query "DESCRIBE TABLE otel_metrics_gauge"
```

Expected columns include: `ResourceAttributes Map(LowCardinality(String), String)`, `MetricName String`, `Value Float64`, `TimeUnix DateTime64(9)`. **Save this output** — Task 5 SQL is written against it. There is no `ServiceName` column on metrics tables; always use `ResourceAttributes['service.name']`.

- [ ] **Step 6: Commit**

```bash
git add docker/otel-collector-config.yml
git commit -m "feat: enable otel collector metrics pipeline into clickhouse"
```

---

### Task 2: Signal synthesis — pure functions (Go, TDD)

**Files:**
- Create: `trace-generator/metrics_test.go`
- Create: `trace-generator/metrics.go`

**Interfaces:**
- Produces (used by Tasks 3): `s5EpisodeActive(ts time.Time) bool`, `signalBaseValue(service, pod, metric string, ts time.Time) float64`, `jitteredSignalValue(service, pod, metric string, ts time.Time) float64`, constants `s5EpisodePeriodMin`, `s5EpisodeLenMin`, `scenarioAuthMemoryLeakErrorRateInEpisode`, `scenarioAuthMemoryLeakErrorRateOffEpisode`, `metricNames` slice, `metricPods() []podIdentity`.

Design constraint (campaign "p95 of a ramp" trap): S5 memory saturation must be **episodic** — 3 minutes of every 15 (20% duty) — so a selection over a 503 burst sees p95 ≥ 0.85 while the excluded baseline p95 stays ≤ ~0.6. A monotonic ramp collapses the score.

- [ ] **Step 1: Write the failing tests**

Create `trace-generator/metrics_test.go`:

```go
package main

import (
	"testing"
	"time"
)

func TestS5EpisodeIsThreeMinutesOfEveryFifteen(t *testing.T) {
	// Minutes 0,1,2 of each 15-min block are active; 3..14 are not.
	cases := []struct {
		minute int64
		active bool
	}{
		{0, true}, {1, true}, {2, true}, {3, false}, {8, false}, {14, false},
		{15, true}, {16, true}, {18, false}, {29, false}, {30, true},
	}
	for _, c := range cases {
		ts := time.Unix(c.minute*60, 0)
		if got := s5EpisodeActive(ts); got != c.active {
			t.Fatalf("minute %d: expected active=%v, got %v", c.minute, c.active, got)
		}
	}
}

func TestS5MemorySaturatesOnlyTargetPodsInsideEpisodes(t *testing.T) {
	inEpisode := time.Unix(60, 0)   // minute 1 — active
	offEpisode := time.Unix(300, 0) // minute 5 — inactive

	if v := signalBaseValue("user-service", "pod-abc-7", "memory.utilization", inEpisode); v < 0.85 {
		t.Fatalf("pod-abc-7 memory in episode should saturate (>=0.85), got %f", v)
	}
	if v := signalBaseValue("user-service", "pod-abc-7", "memory.utilization", offEpisode); v < 0.20 || v > 0.50 {
		t.Fatalf("pod-abc-7 memory off-episode should be baseline [0.20,0.50], got %f", v)
	}
	if v := signalBaseValue("user-service", "pod-abc-1", "memory.utilization", inEpisode); v < 0.20 || v > 0.50 {
		t.Fatalf("healthy pod-abc-1 must never saturate, got %f", v)
	}
	if v := signalBaseValue("order-service", "pod-abc-7", "memory.utilization", inEpisode); v < 0.20 || v > 0.50 {
		t.Fatalf("other services must never S5-saturate, got %f", v)
	}
}

func TestSearchServicePinnedCPUAndQueue(t *testing.T) {
	ts := time.Unix(300, 0)
	if v := signalBaseValue("search-service", "pod-abc-1", "cpu.utilization", ts); v < 0.85 {
		t.Fatalf("search-service cpu should be pinned >=0.85, got %f", v)
	}
	if v := signalBaseValue("api-gateway", "pod-abc-1", "cpu.utilization", ts); v < 0.20 || v > 0.50 {
		t.Fatalf("api-gateway cpu should be baseline, got %f", v)
	}
	search := signalBaseValue("search-service", "pod-abc-1", "queue.depth", ts)
	other := signalBaseValue("api-gateway", "pod-abc-1", "queue.depth", ts)
	if search < 5*other {
		t.Fatalf("search-service queue.depth (%f) should be >=5x baseline (%f)", search, other)
	}
}

func TestJitteredValuesStayInBands(t *testing.T) {
	inEpisode := time.Unix(60, 0)
	for i := 0; i < 200; i++ {
		v := jitteredSignalValue("user-service", "pod-abc-7", "memory.utilization", inEpisode)
		if v < 0.85 || v > 0.99 {
			t.Fatalf("saturated jittered memory out of band: %f", v)
		}
		b := jitteredSignalValue("api-gateway", "pod-abc-1", "cpu.utilization", inEpisode)
		if b < 0.15 || b > 0.55 {
			t.Fatalf("baseline jittered cpu out of band: %f", b)
		}
		q := jitteredSignalValue("api-gateway", "pod-abc-1", "queue.depth", inEpisode)
		if q < 0 {
			t.Fatalf("queue depth must be non-negative: %f", q)
		}
	}
}

func TestMetricPodsCoverS5Pods(t *testing.T) {
	pods := metricPods()
	found7, found8 := false, false
	for _, p := range pods {
		if p.service == "user-service" && p.pod == "pod-abc-7" {
			found7 = true
		}
		if p.service == "user-service" && p.pod == "pod-abc-8" {
			found8 = true
		}
	}
	if !found7 || !found8 {
		t.Fatalf("metricPods must include user-service pod-abc-7 and pod-abc-8")
	}
}
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd trace-generator && go test ./... ; cd ..
```

Expected: FAIL — `undefined: s5EpisodeActive` etc.

- [ ] **Step 3: Implement the pure synthesis functions**

Create `trace-generator/metrics.go`:

```go
package main

// Saturation-signal synthesis for the wide-events saturation campaign.
// Pure functions of (service, pod, metric, time) so the emission model is
// unit-testable and the P3 ground-truth gate can PREDICT scores from these
// constants before measuring.

import (
	"math"
	"math/rand"
	"time"
)

const (
	baselineUtilMid   = 0.35
	baselineUtilSwing = 0.10 // sinusoidal swing, 10-min period → baseline in [0.25, 0.45]

	// S5 memory saturation is EPISODIC, not a ramp: a monotonic ramp puts the
	// baseline p95 near the peak too and the p95-delta score collapses to ~0.
	s5EpisodePeriodMin = 15 // one episode per 15-minute block...
	s5EpisodeLenMin    = 3  // ...lasting 3 minutes (20% duty cycle)
	s5SaturatedMemory  = 0.92

	s8PinnedCPU        = 0.90
	queueBaselineDepth = 3.0
	s8QueueDepth       = 45.0

	// S5 503s concentrate inside saturation episodes so the error burst is
	// time-localized and a selection over it correlates with the memory signal.
	// Weighted average = 0.40*(3/15) + 0.01*(12/15) = 0.088 — still conservative
	// for local SLO calibration (see main_test.go).
	scenarioAuthMemoryLeakErrorRateInEpisode  = 0.40
	scenarioAuthMemoryLeakErrorRateOffEpisode = 0.01
)

var metricNames = []string{
	"cpu.utilization",
	"memory.utilization",
	"db.pool.utilization",
	"queue.depth",
}

// s5EpisodeActive reports whether ts falls inside an S5 memory-saturation
// episode: minutes [0, s5EpisodeLenMin) of every s5EpisodePeriodMin-minute block.
func s5EpisodeActive(ts time.Time) bool {
	return (ts.Unix()/60)%s5EpisodePeriodMin < s5EpisodeLenMin
}

// signalBaseValue returns the deterministic component of a signal.
// Random jitter is added at emission time (jitteredSignalValue), not here.
func signalBaseValue(service, pod, metric string, ts time.Time) float64 {
	phase := float64(ts.Unix()%600) / 600 * 2 * math.Pi
	base := baselineUtilMid + baselineUtilSwing*math.Sin(phase)

	switch metric {
	case "memory.utilization":
		if service == "user-service" && (pod == "pod-abc-7" || pod == "pod-abc-8") && s5EpisodeActive(ts) {
			return s5SaturatedMemory
		}
		return base
	case "cpu.utilization":
		if service == "search-service" {
			return s8PinnedCPU
		}
		return base
	case "db.pool.utilization":
		return base
	case "queue.depth":
		if service == "search-service" {
			return s8QueueDepth
		}
		return queueBaselineDepth
	}
	return base
}

// jitteredSignalValue adds emission-time noise: ±0.05 absolute for utilization
// signals (clamped so saturated stays saturated and baseline stays in band),
// ±10% relative for queue depth.
func jitteredSignalValue(service, pod, metric string, ts time.Time) float64 {
	v := signalBaseValue(service, pod, metric, ts)
	if metric == "queue.depth" {
		return math.Max(0, v*(1+(rand.Float64()-0.5)*0.2))
	}
	v += (rand.Float64() - 0.5) * 0.10
	return math.Min(0.98, math.Max(0.02, v))
}

type podIdentity struct {
	service, pod string
}

// metricPods lists the (service, pod) identities that emit metrics. Every
// service gets two healthy pods; user-service additionally gets the S5
// saturation pods. Span-side k8s.pod.name is uniform pod-abc-1..8, so
// filtering spans to these pods works (pods are SpanAttributes, main.go:415).
func metricPods() []podIdentity {
	services := []string{
		"api-gateway",
		"order-service",
		"user-service",
		"search-service",
		"payment-service",
		"notification-service",
	}
	pods := make([]podIdentity, 0, len(services)*2+2)
	for _, svc := range services {
		pods = append(pods, podIdentity{svc, "pod-abc-1"}, podIdentity{svc, "pod-abc-2"})
	}
	pods = append(pods, podIdentity{"user-service", "pod-abc-7"}, podIdentity{"user-service", "pod-abc-8"})
	return pods
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
cd trace-generator && go test ./... ; cd ..
```

Expected: `ok` — all tests pass (existing burn tests included).

- [ ] **Step 5: Commit**

```bash
git add trace-generator/metrics.go trace-generator/metrics_test.go
git commit -m "feat: pure saturation-signal synthesis with episodic S5 model"
```

---

### Task 3: Gauge emission + episodic S5 503s (Go; campaign P2)

**Files:**
- Modify: `trace-generator/metrics.go` (append emission code)
- Modify: `trace-generator/main.go` (wire emitters; S5 error modulation; delete old constant)
- Modify: `trace-generator/main_test.go` (weighted-average assertion)

**Interfaces:**
- Consumes: everything from Task 2.
- Produces: OTLP gauges every 10s per (service, pod) with metric-side resource attrs `service.name` + `k8s.pod.name`; ClickHouse rows in `otel_metrics_gauge`.

- [ ] **Step 1: Add metric SDK dependencies**

```bash
cd trace-generator && go get go.opentelemetry.io/otel/sdk/metric go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc && go mod tidy && cd ..
```

Expected: `go.mod` gains `go.opentelemetry.io/otel/sdk/metric` and the exporter; `go.opentelemetry.io/otel/metric` moves out of the `// indirect` block.

- [ ] **Step 2: Update the pinned-rate test (deliberate semantics change)**

This replaces a pinned constant assertion — the change is deliberate and documented (503s become episodic; weighted average stays conservative). In `trace-generator/main_test.go`, replace the whole `TestScenarioErrorRatesAreConservativeForLocalSLOTesting` function (currently lines 44–51) with:

```go
func TestScenarioErrorRatesAreConservativeForLocalSLOTesting(t *testing.T) {
	if scenarioPaymentTimeoutRate > 0.10 {
		t.Fatalf("payment timeout rate too high: %f", scenarioPaymentTimeoutRate)
	}
	// S5 503s are episodic (metrics.go): high inside saturation episodes, near
	// zero outside. The conservativeness bound applies to the weighted average.
	duty := float64(s5EpisodeLenMin) / float64(s5EpisodePeriodMin)
	avg := scenarioAuthMemoryLeakErrorRateInEpisode*duty +
		scenarioAuthMemoryLeakErrorRateOffEpisode*(1-duty)
	if avg > 0.15 {
		t.Fatalf("auth memory leak weighted-average error rate too high: %f", avg)
	}
}
```

- [ ] **Step 3: Run tests, verify the new assertion compiles and passes but the old constant is now unreferenced**

```bash
cd trace-generator && go test ./... ; cd ..
```

Expected: PASS (the old `scenarioAuthMemoryLeakErrorRate` constant still exists and is still used by `emitAuthMemoryLeak` — next step removes both).

- [ ] **Step 4: Make S5 503s episodic in `main.go`**

In `trace-generator/main.go`:

(a) Delete the constant `scenarioAuthMemoryLeakErrorRate = 0.10` (in the `const` block near line 252–257, leaving `scenarioPaymentTimeoutRate`):

```go
const (
	// Keep local dev data mostly healthy so alert calibration can be validated.
	// High values here quickly force sustained breach conditions for 99% SLOs.
	scenarioPaymentTimeoutRate = 0.05
)
```

(b) In `emitAuthMemoryLeak` (near line 687), replace:

```go
	// Intermittent 503 with conservative default for local dev calibration.
	statusCode := 200
	var errMsg string
	if rand.Float64() < scenarioAuthMemoryLeakErrorRate {
		statusCode = 503
		errMsg = "service unavailable: GC overhead"
	}
```

with:

```go
	// Intermittent 503, concentrated inside S5 memory-saturation episodes so
	// the error burst is time-localized and correlates with the metric signal
	// (weighted average stays conservative; see metrics.go + main_test.go).
	errRate := scenarioAuthMemoryLeakErrorRateOffEpisode
	if s5EpisodeActive(ts) {
		errRate = scenarioAuthMemoryLeakErrorRateInEpisode
	}
	statusCode := 200
	var errMsg string
	if rand.Float64() < errRate {
		statusCode = 503
		errMsg = "service unavailable: GC overhead"
	}
```

(Note: `ts` is the trace timestamp parameter — backfilled traces get episodes aligned to their historical timestamps, which is what we want.)

- [ ] **Step 5: Append the emission code to `metrics.go`**

Append to `trace-generator/metrics.go`:

```go
// ── OTLP gauge emission ─────────────────────────────────────────────

// (imports to ADD to the import block at the top of this file:)
//   "context"
//   "go.opentelemetry.io/otel/attribute"
//   "go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
//   "go.opentelemetry.io/otel/metric"
//   sdkmetric "go.opentelemetry.io/otel/sdk/metric"
//   "go.opentelemetry.io/otel/sdk/resource"
//   semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
//   "google.golang.org/grpc"

// startMetricEmitters registers observable gauges for every (service, pod)
// identity and exports them via OTLP every 10s. One MeterProvider per
// identity so ResourceAttributes carry service.name + k8s.pod.name.
// Volume: 14 identities x 4 metrics / 10s ≈ 5.6 rows/sec — negligible next
// to span volume.
func startMetricEmitters(ctx context.Context, conn *grpc.ClientConn) (func(context.Context), error) {
	var providers []*sdkmetric.MeterProvider

	for _, p := range metricPods() {
		p := p
		exp, err := otlpmetricgrpc.New(ctx, otlpmetricgrpc.WithGRPCConn(conn))
		if err != nil {
			return nil, err
		}
		res, err := resource.New(ctx,
			resource.WithAttributes(
				semconv.ServiceName(p.service),
				attribute.String("k8s.pod.name", p.pod),
			),
		)
		if err != nil {
			return nil, err
		}
		mp := sdkmetric.NewMeterProvider(
			sdkmetric.WithResource(res),
			sdkmetric.WithReader(sdkmetric.NewPeriodicReader(exp, sdkmetric.WithInterval(10*time.Second))),
		)
		meter := mp.Meter("trace-generator")

		for _, name := range metricNames {
			name := name
			g, err := meter.Float64ObservableGauge(name)
			if err != nil {
				return nil, err
			}
			if _, err := meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
				o.ObserveFloat64(g, jitteredSignalValue(p.service, p.pod, name, time.Now()))
				return nil
			}, g); err != nil {
				return nil, err
			}
		}
		providers = append(providers, mp)
	}

	return func(sctx context.Context) {
		for _, mp := range providers {
			_ = mp.Shutdown(sctx)
		}
	}, nil
}
```

Move the commented import lines into the actual `import` block at the top of `metrics.go` (final import block: `context`, `math`, `math/rand`, `time`, plus the six otel/grpc imports above).

- [ ] **Step 6: Wire emitters in `main()`**

In `trace-generator/main.go`, after `st := newServiceTracers(ctx, exporter)` (line ~1063), add:

```go
	metricsShutdown, err := startMetricEmitters(ctx, conn)
	if err != nil {
		log.Fatalf("failed to start metric emitters: %v", err)
	}
```

and inside the existing shutdown `defer func() { ... }()` (line ~1073), after `st.shutdown(shutdownCtx)`, add:

```go
		metricsShutdown(shutdownCtx)
```

- [ ] **Step 7: Tests + build**

```bash
cd trace-generator && go test ./... && go build ./... ; cd ..
```

Expected: PASS, clean build. Compile errors about unused imports → fix the import block per Step 5.

- [ ] **Step 8: Rebuild the container and watch it come up**

```bash
docker compose -f docker/docker-compose.yml up -d --build trace-generator
docker compose -f docker/docker-compose.yml logs trace-generator --tail 10
```

Expected: backfill log lines then "backfill complete, starting live emission..." with no errors.

- [ ] **Step 9: GATE P2 — scenario-correlated metrics in ClickHouse (wait ≥10 min after restart for a full episode cycle)**

```bash
docker exec clickhouse-server clickhouse-client --query "
SELECT ResourceAttributes['k8s.pod.name'] AS pod,
       round(avg(Value), 3) AS avg_mem, round(max(Value), 3) AS max_mem
FROM otel_metrics_gauge
WHERE MetricName = 'memory.utilization'
  AND ResourceAttributes['service.name'] = 'user-service'
  AND TimeUnix > now() - INTERVAL 20 MINUTE
GROUP BY pod ORDER BY max_mem DESC"
```

Expected: `pod-abc-7` and `pod-abc-8` with `max_mem >= 0.85`; `pod-abc-1`/`pod-abc-2` with avg AND max inside 0.15–0.55.

```bash
docker exec clickhouse-server clickhouse-client --query "
SELECT ResourceAttributes['service.name'] AS service,
       round(quantile(0.95)(Value), 3) AS p95_cpu
FROM otel_metrics_gauge
WHERE MetricName = 'cpu.utilization' AND TimeUnix > now() - INTERVAL 10 MINUTE
GROUP BY service ORDER BY p95_cpu DESC"
```

Expected: `search-service` ≥ 0.85; every other service ≤ 0.55. Run the same for `queue.depth` (expect search-service ≈ 40–50, others ≈ 3).

Branches: rows exist but bands wrong → emission logic (Task 2 constants), fix in Go. No rows → `make logs-collector` (P1 pipeline). Marginal separation → fix now; the Task 6 gate will fail otherwise.

- [ ] **Step 10: Commit**

```bash
git add trace-generator/metrics.go trace-generator/main.go trace-generator/main_test.go trace-generator/go.mod trace-generator/go.sum
git commit -m "feat: emit scenario-correlated saturation gauges; make S5 503s episodic"
```

---

### Task 4: Scoring layer (TypeScript, TDD; campaign P3 part 1)

**Files:**
- Create: `packages/shared-comparison/src/saturation.ts`
- Create: `plugins/heatmap-app/src/saturation.test.ts`
- Modify: `packages/shared-comparison/src/index.ts`

**Interfaces:**
- Produces (used by Tasks 5–7):

```ts
export type SignalKind = 'utilization' | 'counter';
export interface SaturationSignal { metricName: string; kind: SignalKind; label: string; }
export const SATURATION_SIGNALS: SaturationSignal[];
export interface ResourceComparisonRow {
  service: string; pod: string; metricName: string;
  p95Selection: number | null; p95Baseline: number | null;
  selectionSamples: number; maxSelection: number | null;
}
export interface SaturationScore {
  service: string; pod: string; signal: SaturationSignal;
  score: number; selectionValue: number; baselineValue: number; lowConfidence: boolean;
}
export function scoreSaturation(rows: ResourceComparisonRow[]): SaturationScore[];
export const MIN_SELECTION_SAMPLES: number; // 3
```

- [ ] **Step 1: Write the failing tests**

Create `plugins/heatmap-app/src/saturation.test.ts`:

```ts
import {
  scoreSaturation,
  SATURATION_SIGNALS,
  ResourceComparisonRow,
} from '../../../packages/shared-comparison/src/saturation';

const row = (over: Partial<ResourceComparisonRow>): ResourceComparisonRow => ({
  service: 'user-service',
  pod: 'pod-abc-7',
  metricName: 'memory.utilization',
  p95Selection: 0.92,
  p95Baseline: 0.4,
  selectionSamples: 20,
  maxSelection: 0.95,
  ...over,
});

describe('SATURATION_SIGNALS registry', () => {
  it('contains the four v1 signals with correct kinds', () => {
    const byName = Object.fromEntries(SATURATION_SIGNALS.map((s) => [s.metricName, s.kind]));
    expect(byName).toEqual({
      'cpu.utilization': 'utilization',
      'memory.utilization': 'utilization',
      'db.pool.utilization': 'utilization',
      'queue.depth': 'counter',
    });
  });
});

describe('scoreSaturation', () => {
  it('scores utilization as p95 delta and ranks descending', () => {
    const scores = scoreSaturation([
      row({ p95Selection: 0.92, p95Baseline: 0.4 }), // +0.52
      row({ service: 'api-gateway', metricName: 'cpu.utilization', p95Selection: 0.5, p95Baseline: 0.4 }), // +0.10
    ]);
    expect(scores).toHaveLength(2);
    expect(scores[0].service).toBe('user-service');
    expect(scores[0].score).toBeCloseTo(0.52);
    expect(scores[1].score).toBeCloseTo(0.1);
  });

  it('drops zero and negative deltas (directional, selection-first)', () => {
    const scores = scoreSaturation([
      row({ p95Selection: 0.4, p95Baseline: 0.4 }),
      row({ p95Selection: 0.3, p95Baseline: 0.6 }),
    ]);
    expect(scores).toHaveLength(0);
  });

  it('scores counters as relative delta against their own baseline', () => {
    const scores = scoreSaturation([
      row({ metricName: 'queue.depth', p95Selection: 45, p95Baseline: 3 }),
    ]);
    expect(scores).toHaveLength(1);
    expect(scores[0].score).toBeCloseTo((45 - 3) / 3);
  });

  it('treats a missing baseline like zero (new-signal case)', () => {
    const scores = scoreSaturation([row({ p95Baseline: null, p95Selection: 0.9 })]);
    expect(scores).toHaveLength(1);
    expect(scores[0].score).toBeCloseTo(0.9);
  });

  it('skips rows with no selection value and unknown metrics', () => {
    const scores = scoreSaturation([
      row({ p95Selection: null, maxSelection: null }),
      row({ metricName: 'not.a.signal' }),
    ]);
    expect(scores).toHaveLength(0);
  });

  it('falls back to maxSelection and flags lowConfidence for small selections', () => {
    const scores = scoreSaturation([
      row({ selectionSamples: 1, p95Selection: null, maxSelection: 0.9, p95Baseline: 0.4 }),
    ]);
    expect(scores).toHaveLength(1);
    expect(scores[0].lowConfidence).toBe(true);
    expect(scores[0].selectionValue).toBeCloseTo(0.9);
    expect(scores[0].score).toBeCloseTo(0.5);
  });

  it('breaks ties deterministically by service, then pod', () => {
    const scores = scoreSaturation([
      row({ service: 'zeta-svc', p95Selection: 0.9, p95Baseline: 0.4 }),
      row({ service: 'alpha-svc', p95Selection: 0.9, p95Baseline: 0.4 }),
    ]);
    expect(scores.map((s) => s.service)).toEqual(['alpha-svc', 'zeta-svc']);
  });

  it('returns empty for empty input', () => {
    expect(scoreSaturation([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npm run test:ci --workspace=plugins/heatmap-app
```

Expected: FAIL — cannot find module `.../saturation`.

- [ ] **Step 3: Implement**

Create `packages/shared-comparison/src/saturation.ts`:

```ts
export type SignalKind = 'utilization' | 'counter';

export interface SaturationSignal {
  metricName: string;
  kind: SignalKind;
  label: string;
}

/** v1 signal registry — hardcoded, mirrors trace-generator/metrics.go. */
export const SATURATION_SIGNALS: SaturationSignal[] = [
  { metricName: 'cpu.utilization', kind: 'utilization', label: 'CPU' },
  { metricName: 'memory.utilization', kind: 'utilization', label: 'Memory' },
  { metricName: 'db.pool.utilization', kind: 'utilization', label: 'DB pool' },
  { metricName: 'queue.depth', kind: 'counter', label: 'Queue depth' },
];

/** Below this many datapoints in the selection window, p95 is unstable — fall back to max and flag. */
export const MIN_SELECTION_SAMPLES = 3;

export interface ResourceComparisonRow {
  service: string;
  pod: string;
  metricName: string;
  p95Selection: number | null;
  p95Baseline: number | null;
  selectionSamples: number;
  maxSelection: number | null;
}

export interface SaturationScore {
  service: string;
  pod: string;
  signal: SaturationSignal;
  score: number;
  selectionValue: number;
  baselineValue: number;
  lowConfidence: boolean;
}

const COUNTER_EPSILON = 1e-6;

/**
 * Directional, selection-first scoring — same semantics as computeComparison:
 * only over-representation in the selection is signal; score <= 0 is dropped.
 * utilization: score = p95_selection - p95_baseline (percentage points).
 * counter:     score = (p95_selection - p95_baseline) / max(p95_baseline, eps).
 * ponytail: p95-delta scoring; upgrade is effect-size normalization (z-score)
 * if noisy signals demonstrably mis-rank — frontier work, do not gold-plate.
 */
export function scoreSaturation(rows: ResourceComparisonRow[]): SaturationScore[] {
  const signalByName = new Map(SATURATION_SIGNALS.map((s) => [s.metricName, s]));
  const scores: SaturationScore[] = [];

  for (const r of rows) {
    const signal = signalByName.get(r.metricName);
    if (!signal) {
      continue;
    }

    const lowConfidence = r.selectionSamples < MIN_SELECTION_SAMPLES;
    const selectionValue = lowConfidence ? r.maxSelection : r.p95Selection;
    if (selectionValue == null || !isFinite(selectionValue)) {
      continue;
    }
    const baselineValue = r.p95Baseline != null && isFinite(r.p95Baseline) ? r.p95Baseline : 0;

    const score =
      signal.kind === 'utilization'
        ? selectionValue - baselineValue
        : (selectionValue - baselineValue) / Math.max(baselineValue, COUNTER_EPSILON);

    if (score <= 0) {
      continue;
    }
    scores.push({ service: r.service, pod: r.pod, signal, score, selectionValue, baselineValue, lowConfidence });
  }

  scores.sort(
    (a, b) =>
      b.score - a.score ||
      a.service.localeCompare(b.service) ||
      a.pod.localeCompare(b.pod)
  );
  return scores;
}
```

- [ ] **Step 4: Export from the package index**

In `packages/shared-comparison/src/index.ts`, append:

```ts
export { SATURATION_SIGNALS, MIN_SELECTION_SAMPLES, scoreSaturation } from './saturation';
export type { SaturationSignal, SignalKind, ResourceComparisonRow, SaturationScore } from './saturation';
```

- [ ] **Step 5: Run tests, verify they pass**

```bash
npm run test:ci --workspace=plugins/heatmap-app
```

Expected: PASS (all suites, including the pre-existing 13 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared-comparison/src/saturation.ts packages/shared-comparison/src/index.ts plugins/heatmap-app/src/saturation.test.ts
git commit -m "feat: saturation signal registry and directional p95-delta scorer"
```

---

### Task 5: SQL builders (TypeScript, TDD; campaign P3 part 2)

**Files:**
- Create: `packages/shared-comparison/src/saturationSql.ts`
- Create: `plugins/heatmap-app/src/saturationSql.test.ts`
- Modify: `packages/shared-comparison/src/index.ts`

**Interfaces:**
- Consumes: `SATURATION_SIGNALS` (Task 4), `escapeSql` from `./sqlFilters`.
- Produces (used by Tasks 6–7):

```ts
export const DEFAULT_METRICS_TABLE: string; // 'otel_metrics_gauge'
export interface MsWindow { fromMs: number; toMs: number; }
export function buildResourceSeriesSql(services: string[], table?: string): string;      // strip: uses $__timeFilter(TimeUnix)
export function buildSaturationComparisonSql(selection: MsWindow, panel: MsWindow, services: string[], table?: string): string;
export function buildResourceDetailSql(service: string, pod: string, table?: string): string; // detail panel: one column per signal
```

Column order contract of the comparison query (Task 7's parser is positional, house style): `service, pod, metric, p95_selection, p95_baseline, selection_samples, max_selection`.

- [ ] **Step 1: Write the failing tests**

Create `plugins/heatmap-app/src/saturationSql.test.ts`:

```ts
import {
  buildResourceSeriesSql,
  buildSaturationComparisonSql,
  buildResourceDetailSql,
  DEFAULT_METRICS_TABLE,
} from '../../../packages/shared-comparison/src/saturationSql';

describe('buildResourceSeriesSql', () => {
  it('aggregates max utilization per bucket with the grafana time macro', () => {
    const sql = buildResourceSeriesSql([]);
    expect(sql).toContain('$__timeFilter(TimeUnix)');
    expect(sql).toContain(`FROM ${DEFAULT_METRICS_TABLE}`);
    expect(sql).toContain("'cpu.utilization', 'memory.utilization', 'db.pool.utilization'");
    expect(sql).not.toContain('queue.depth'); // counters are not 0-1 comparable; strip is utilization-only
    expect(sql).not.toContain("ResourceAttributes['service.name'] IN");
  });

  it('filters and escapes service names', () => {
    const sql = buildResourceSeriesSql(["user-service", "bad'svc"]);
    expect(sql).toContain("ResourceAttributes['service.name'] IN ('user-service', 'bad\\'svc')");
  });
});

describe('buildSaturationComparisonSql', () => {
  const selection = { fromMs: 1000, toMs: 2000 };
  const panel = { fromMs: 0, toMs: 10000 };

  it('computes selection and baseline p95 in one pass with the documented column order', () => {
    const sql = buildSaturationComparisonSql(selection, panel, []);
    expect(sql).toContain(
      'quantileIf(0.95)(Value, TimeUnix >= fromUnixTimestamp64Milli(1000) AND TimeUnix <= fromUnixTimestamp64Milli(2000)) AS p95_selection'
    );
    expect(sql).toContain(
      'quantileIf(0.95)(Value, NOT (TimeUnix >= fromUnixTimestamp64Milli(1000) AND TimeUnix <= fromUnixTimestamp64Milli(2000))) AS p95_baseline'
    );
    // baseline is bounded by the panel window in the outer WHERE
    expect(sql).toContain('WHERE TimeUnix >= fromUnixTimestamp64Milli(0) AND TimeUnix <= fromUnixTimestamp64Milli(10000)');
    // positional parse contract
    const selectIdx = ['AS service', 'AS pod', 'AS metric', 'AS p95_selection', 'AS p95_baseline', 'AS selection_samples', 'AS max_selection'].map((c) => sql.indexOf(c));
    expect([...selectIdx].sort((a, b) => a - b)).toEqual(selectIdx);
    expect(sql).toContain('GROUP BY service, pod, metric');
    // all four signals included
    expect(sql).toContain("'queue.depth'");
  });

  it('floors fractional milliseconds', () => {
    const sql = buildSaturationComparisonSql({ fromMs: 1000.9, toMs: 2000.9 }, panel, []);
    expect(sql).toContain('fromUnixTimestamp64Milli(1000)');
    expect(sql).toContain('fromUnixTimestamp64Milli(2000)');
  });

  it('applies the escaped service filter', () => {
    const sql = buildSaturationComparisonSql(selection, panel, ["a'b"]);
    expect(sql).toContain("AND ResourceAttributes['service.name'] IN ('a\\'b')");
  });
});

describe('buildResourceDetailSql', () => {
  it('pivots one column per signal for a single resource, escaped', () => {
    const sql = buildResourceDetailSql("user-service", "pod'7");
    expect(sql).toContain('$__timeFilter(TimeUnix)');
    expect(sql).toContain("ResourceAttributes['service.name'] = 'user-service'");
    expect(sql).toContain("ResourceAttributes['k8s.pod.name'] = 'pod\\'7'");
    expect(sql).toContain("maxIf(Value, MetricName = 'cpu.utilization') AS \"CPU\"");
    expect(sql).toContain("maxIf(Value, MetricName = 'queue.depth') AS \"Queue depth\"");
    expect(sql).toContain('GROUP BY time');
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npm run test:ci --workspace=plugins/heatmap-app
```

Expected: FAIL — cannot find module `.../saturationSql`.

- [ ] **Step 3: Implement**

Create `packages/shared-comparison/src/saturationSql.ts`:

```ts
import { escapeSql } from './sqlFilters';
import { SATURATION_SIGNALS } from './saturation';

/**
 * Metrics land in the table created by the collector's ClickHouse exporter
 * (docker/otel-collector-config.yml, create_schema: true). Verified against
 * otel_metrics_gauge: ResourceAttributes Map, MetricName, Value Float64,
 * TimeUnix DateTime64(9). There is NO ServiceName column on metrics tables —
 * always ResourceAttributes['service.name'].
 */
export const DEFAULT_METRICS_TABLE = 'otel_metrics_gauge';

export interface MsWindow {
  fromMs: number;
  toMs: number;
}

const quoted = (v: string) => `'${escapeSql(v)}'`;

function serviceFilter(services: string[]): string {
  if (services.length === 0) {
    return '';
  }
  return `\n  AND ResourceAttributes['service.name'] IN (${services.map(quoted).join(', ')})`;
}

function timePredicate(w: MsWindow): string {
  return `TimeUnix >= fromUnixTimestamp64Milli(${Math.floor(w.fromMs)}) AND TimeUnix <= fromUnixTimestamp64Milli(${Math.floor(w.toMs)})`;
}

/** Ambient strip: max utilization per 15s bucket across the in-view services. Utilization-only — counters are not 0-1 comparable. */
export function buildResourceSeriesSql(services: string[], table = DEFAULT_METRICS_TABLE): string {
  const utilization = SATURATION_SIGNALS.filter((s) => s.kind === 'utilization')
    .map((s) => quoted(s.metricName))
    .join(', ');
  return `SELECT
  toStartOfInterval(TimeUnix, INTERVAL 15 SECOND) AS time,
  max(Value) AS saturation
FROM ${table}
WHERE $__timeFilter(TimeUnix)
  AND MetricName IN (${utilization})${serviceFilter(services)}
GROUP BY time
ORDER BY time`;
}

/**
 * One pass over the gauge table: p95 inside the selection window vs p95 in the
 * rest of the panel window, per (service, pod, metric). Baseline = panel
 * window AND NOT selection — mirrors the span-side pattern in
 * AttributeComparisonPanel.runComparison. Column order is the positional
 * parse contract for parseComparisonFrames — keep in sync.
 * NOTE: selection traceIds do NOT apply here (metrics cannot join on traces);
 * correlation is time + service only, by design.
 */
export function buildSaturationComparisonSql(
  selection: MsWindow,
  panel: MsWindow,
  services: string[],
  table = DEFAULT_METRICS_TABLE
): string {
  const selPred = timePredicate(selection);
  const allSignals = SATURATION_SIGNALS.map((s) => quoted(s.metricName)).join(', ');
  return `SELECT
  ResourceAttributes['service.name'] AS service,
  ResourceAttributes['k8s.pod.name'] AS pod,
  MetricName AS metric,
  quantileIf(0.95)(Value, ${selPred}) AS p95_selection,
  quantileIf(0.95)(Value, NOT (${selPred})) AS p95_baseline,
  countIf(${selPred}) AS selection_samples,
  maxIf(Value, ${selPred}) AS max_selection
FROM ${table}
WHERE ${timePredicate(panel)}
  AND MetricName IN (${allSignals})${serviceFilter(services)}
GROUP BY service, pod, metric`;
}

/** Resource detail panel: one series per signal for a single (service, pod). */
export function buildResourceDetailSql(service: string, pod: string, table = DEFAULT_METRICS_TABLE): string {
  const pivots = SATURATION_SIGNALS.map(
    (s) => `maxIf(Value, MetricName = ${quoted(s.metricName)}) AS "${s.label}"`
  ).join(',\n  ');
  return `SELECT
  toStartOfInterval(TimeUnix, INTERVAL 15 SECOND) AS time,
  ${pivots}
FROM ${table}
WHERE $__timeFilter(TimeUnix)
  AND ResourceAttributes['service.name'] = ${quoted(service)}
  AND ResourceAttributes['k8s.pod.name'] = ${quoted(pod)}
GROUP BY time
ORDER BY time`;
}
```

- [ ] **Step 4: Export from the package index**

In `packages/shared-comparison/src/index.ts`, append:

```ts
export {
  DEFAULT_METRICS_TABLE,
  buildResourceSeriesSql,
  buildSaturationComparisonSql,
  buildResourceDetailSql,
} from './saturationSql';
export type { MsWindow } from './saturationSql';
```

- [ ] **Step 5: Run tests, verify they pass**

```bash
npm run test:ci --workspace=plugins/heatmap-app
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared-comparison/src/saturationSql.ts packages/shared-comparison/src/index.ts plugins/heatmap-app/src/saturationSql.test.ts
git commit -m "feat: saturation SQL builders (strip, comparison, resource detail)"
```

---

### Task 6: GATE P3 — ground-truth check with a predicted number (no code)

**Interfaces:**
- Consumes: running stack with Tasks 1–5 complete.
- Produces: recorded numbers for the PR body (`/tmp/saturation-gate-notes.md` — NOT committed).

The discipline (campaign + `heatmap-research-methodology`): write the prediction BEFORE running the query. A right ranking with an unpredicted number is not a pass.

- [ ] **Step 1: Write the prediction first**

Create `/tmp/saturation-gate-notes.md` with (fill the date):

```markdown
# P3 ground-truth prediction (written BEFORE measuring)
From trace-generator/metrics.go constants:
- Episode: memory.utilization = 0.92 ± 0.05 jitter → selection covering an episode: p95_selection in [0.87, 0.97]
- Baseline: 0.35 ± 0.10 swing ± 0.05 jitter, no episode in the excluded window → p95_baseline in [0.40, 0.55]
- PREDICTED: user-service/pod-abc-7 and pod-abc-8 memory.utilization rank 1-2, score in [+0.32, +0.57]
- Assumption: panel window = one 15-min block containing exactly one episode; selection covers the episode.
```

- [ ] **Step 2: Compute the most recent complete episode window**

```bash
node -e "
const block = Math.floor(Date.now() / 900000) * 900000 - 900000; // previous 15-min block
console.log('panel:     from', block, 'to', block + 900000);
console.log('selection: from', block, 'to', block + 180000);     // minutes 0-3 = the episode
console.log('human:', new Date(block).toISOString(), '->', new Date(block + 180000).toISOString());"
```

Precondition: metrics must have been flowing during that block (Task 3 finished ≥ 15 min ago). If not, wait for the next block boundary.

- [ ] **Step 3: Run the comparison SQL with those windows and score by eye-independent ordering**

Substitute the four numbers from Step 2 into (`SEL_FROM`, `SEL_TO`, `PANEL_FROM`, `PANEL_TO`) — this is exactly what `buildSaturationComparisonSql` generates, wrapped in an ORDER BY for readability:

```bash
docker exec clickhouse-server clickhouse-client --query "
SELECT
  ResourceAttributes['service.name'] AS service,
  ResourceAttributes['k8s.pod.name'] AS pod,
  MetricName AS metric,
  round(quantileIf(0.95)(Value, TimeUnix >= fromUnixTimestamp64Milli(SEL_FROM) AND TimeUnix <= fromUnixTimestamp64Milli(SEL_TO)), 3) AS p95_selection,
  round(quantileIf(0.95)(Value, NOT (TimeUnix >= fromUnixTimestamp64Milli(SEL_FROM) AND TimeUnix <= fromUnixTimestamp64Milli(SEL_TO))), 3) AS p95_baseline,
  round(p95_selection - p95_baseline, 3) AS delta
FROM otel_metrics_gauge
WHERE TimeUnix >= fromUnixTimestamp64Milli(PANEL_FROM) AND TimeUnix <= fromUnixTimestamp64Milli(PANEL_TO)
  AND MetricName IN ('cpu.utilization', 'memory.utilization', 'db.pool.utilization', 'queue.depth')
GROUP BY service, pod, metric
ORDER BY delta DESC
LIMIT 5"
```

**GATE**: rows 1–2 are `user-service` / `pod-abc-7|8` / `memory.utilization` with `delta` inside your predicted band. Record the actual numbers in `/tmp/saturation-gate-notes.md`.

- Wrong signal ranks first → revisit the episodic-emission constants (Task 2), not the scorer.
- Ranking right but delta outside the band → you don't understand your own emission model; reconcile (see `heatmap-proof-and-analysis-toolkit` R1/R2) before proceeding.

- [ ] **Step 4: Record query latency (Approach B's tripwire)**

Re-run the Step 3 query with `time` prefixed (`time docker exec ...`). Record wall-clock in the notes file. This number goes in the PR as the measured baseline for the materialized-view upgrade trigger.

---

### Task 7: SaturationPanel — cards, empty state, actions (TS + TDD for the parser)

**Files:**
- Create: `packages/shared-comparison/src/SaturationPanel.tsx`
- Create: `plugins/heatmap-app/src/saturationParse.test.ts`
- Create: `plugins/heatmap-app/src/components/Bubbles/SaturationPanel.ts`
- Modify: `packages/shared-comparison/src/index.ts`

**Interfaces:**
- Consumes: `scoreSaturation`, `buildSaturationComparisonSql`, `HeatmapSelection`, `sceneGraph.getTimeRange`, `AdHocFiltersVariable`/`QueryVariable` (same wiring pattern as `AttributeComparisonPanel`).
- Produces:

```ts
export interface SaturationPanelConfig {
  datasource: { uid: string; type: string };
  metricsTable?: string;
  onViewSignals?: (service: string, pod: string) => void; // app decides what a drawer is
}
export class SaturationPanel extends SceneObjectBase<...> {
  setSelection(selection: HeatmapSelection | null): void;
  setServiceVariable(v: QueryVariable): void;
  setAdHocVariable(v: AdHocFiltersVariable): void;
}
export function parseComparisonFrames(values: unknown[][] | undefined): ResourceComparisonRow[];
```

- [ ] **Step 1: Write the failing parser tests**

Create `plugins/heatmap-app/src/saturationParse.test.ts`:

```ts
import { parseComparisonFrames } from '../../../packages/shared-comparison/src/SaturationPanel';

describe('parseComparisonFrames', () => {
  // Positional contract from buildSaturationComparisonSql:
  // service, pod, metric, p95_selection, p95_baseline, selection_samples, max_selection
  it('maps positional columns into rows', () => {
    const rows = parseComparisonFrames([
      ['user-service'],
      ['pod-abc-7'],
      ['memory.utilization'],
      [0.92],
      [0.4],
      [18],
      [0.95],
    ]);
    expect(rows).toEqual([
      {
        service: 'user-service',
        pod: 'pod-abc-7',
        metricName: 'memory.utilization',
        p95Selection: 0.92,
        p95Baseline: 0.4,
        selectionSamples: 18,
        maxSelection: 0.95,
      },
    ]);
  });

  it('converts null/NaN quantiles (empty windows) to null', () => {
    const rows = parseComparisonFrames([['s'], ['p'], ['cpu.utilization'], [null], [NaN], [0], [null]]);
    expect(rows[0].p95Selection).toBeNull();
    expect(rows[0].p95Baseline).toBeNull();
    expect(rows[0].maxSelection).toBeNull();
    expect(rows[0].selectionSamples).toBe(0);
  });

  it('returns empty for missing or short frames', () => {
    expect(parseComparisonFrames(undefined)).toEqual([]);
    expect(parseComparisonFrames([['a'], ['b']])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
npm run test:ci --workspace=plugins/heatmap-app
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the panel**

Create `packages/shared-comparison/src/SaturationPanel.tsx`:

```tsx
import React from 'react';
import {
  AdHocFiltersVariable,
  QueryVariable,
  SceneComponentProps,
  SceneObjectBase,
  SceneObjectState,
  sceneGraph,
} from '@grafana/scenes';
import { GrafanaTheme2 } from '@grafana/data';
import { Button, Icon, useStyles2 } from '@grafana/ui';
import { css } from '@emotion/css';
import { getBackendSrv } from '@grafana/runtime';
import { lastValueFrom } from 'rxjs';
import { HeatmapSelection } from './types';
import { ResourceComparisonRow, SaturationScore, scoreSaturation } from './saturation';
import { buildSaturationComparisonSql, DEFAULT_METRICS_TABLE } from './saturationSql';

export interface SaturationPanelConfig {
  datasource: { uid: string; type: string };
  metricsTable?: string;
  /** The consuming app decides what "view signals" means (e.g. reveal a detail panel). */
  onViewSignals?: (service: string, pod: string) => void;
}

interface SaturationPanelState extends SceneObjectState {
  selection: HeatmapSelection | null;
  scores: SaturationScore[];
  loading: boolean;
  /** True when the metrics query failed or returned nothing — renders the actionable empty state. */
  unavailable: boolean;
}

/**
 * Positional parser for the buildSaturationComparisonSql column order:
 * service, pod, metric, p95_selection, p95_baseline, selection_samples, max_selection.
 */
export function parseComparisonFrames(values: unknown[][] | undefined): ResourceComparisonRow[] {
  if (!values || values.length < 7) {
    return [];
  }
  const num = (v: unknown): number | null => {
    const n = typeof v === 'number' ? v : Number(v);
    return v == null || !isFinite(n) ? null : n;
  };
  const [services, pods, metrics, p95Sel, p95Base, samples, maxSel] = values;
  return services.map((s, i) => ({
    service: String(s),
    pod: String(pods[i]),
    metricName: String(metrics[i]),
    p95Selection: num(p95Sel[i]),
    p95Baseline: num(p95Base[i]),
    selectionSamples: num(samples[i]) ?? 0,
    maxSelection: num(maxSel[i]),
  }));
}

const MAX_CARDS = 10;

export class SaturationPanel extends SceneObjectBase<SaturationPanelState> {
  private serviceVar: QueryVariable | null = null;
  private adHocVar: AdHocFiltersVariable | null = null;
  private readonly config: SaturationPanelConfig;

  constructor(config: SaturationPanelConfig) {
    super({ selection: null, scores: [], loading: false, unavailable: false });
    this.config = config;
  }

  public setServiceVariable(v: QueryVariable) {
    this.serviceVar = v;
  }

  public setAdHocVariable(v: AdHocFiltersVariable) {
    this.adHocVar = v;
  }

  public setSelection(selection: HeatmapSelection | null) {
    this.setState({ selection });
    if (selection) {
      this.runComparison(selection);
    } else {
      this.setState({ scores: [], loading: false, unavailable: false });
    }
  }

  private services(): string[] {
    if (!this.serviceVar) {
      return [];
    }
    const val = String(this.serviceVar.state.value ?? '');
    return val && val !== '$__all' && val !== '%' ? [val] : [];
  }

  /** Selection traceIds intentionally ignored: metrics cannot join on traces; correlation is time + service only. */
  private async runComparison(sel: HeatmapSelection) {
    this.setState({ loading: true, unavailable: false });

    const tr = sceneGraph.getTimeRange(this).state.value;
    const sql = buildSaturationComparisonSql(
      { fromMs: sel.timeRange.from, toMs: sel.timeRange.to },
      { fromMs: tr.from.valueOf(), toMs: tr.to.valueOf() },
      this.services(),
      this.config.metricsTable ?? DEFAULT_METRICS_TABLE
    );

    try {
      const response = await lastValueFrom(
        getBackendSrv().fetch<{ results: Record<string, { frames: Array<{ data: { values: unknown[][] } }> }> }>({
          url: '/api/ds/query',
          method: 'POST',
          data: {
            queries: [{ refId: 'A', datasource: this.config.datasource, rawSql: sql, format: 1, queryType: 'sql' }],
            from: '0',
            to: String(Date.now()),
          },
        })
      );
      const frames = response.data?.results?.A?.frames;
      const rows = parseComparisonFrames(frames?.[0]?.data?.values);
      const scores = scoreSaturation(rows).slice(0, MAX_CARDS);
      this.setState({ scores, loading: false, unavailable: rows.length === 0 });
    } catch (err) {
      // Non-fatal by construction: metrics absence must never block span-side investigation.
      console.error('Saturation query failed:', err);
      this.setState({ scores: [], loading: false, unavailable: true });
    }
  }

  public filterToPod(pod: string) {
    if (!this.adHocVar) {
      return;
    }
    const existing = this.adHocVar.state.filters;
    if (existing.some((f) => f.key === 'k8s.pod.name' && f.value === pod && f.operator === '=')) {
      return;
    }
    // Works because k8s.pod.name is a SpanAttribute on the span side (buildFilterClause maps it).
    this.adHocVar.setState({ filters: [...existing, { key: 'k8s.pod.name', value: pod, operator: '=', condition: '' }] });
  }

  public focusService(service: string) {
    this.serviceVar?.changeValueTo(service, service);
  }

  public viewSignals(service: string, pod: string) {
    this.config.onViewSignals?.(service, pod);
  }

  public static Component = ({ model }: SceneComponentProps<SaturationPanel>) => {
    const { selection, scores, loading, unavailable } = model.useState();
    const styles = useStyles2(getStyles);

    if (!selection) {
      return (
        <div className={styles.container}>
          <div className={styles.hint}>
            <Icon name="fire" /> Select a region on the heatmap to see whether infrastructure was saturated during it.
          </div>
        </div>
      );
    }
    if (loading) {
      return <div className={styles.container}><div className={styles.hint}>Comparing resource saturation…</div></div>;
    }
    if (unavailable) {
      return (
        <div className={styles.container}>
          <div className={styles.hint}>
            No infra metrics found for this window. Check that the collector metrics pipeline is enabled
            (docker/otel-collector-config.yml, `metrics:` pipeline) and that trace-generator is emitting gauges —
            then re-select. Span-side analysis above is unaffected.
          </div>
        </div>
      );
    }
    if (scores.length === 0) {
      return (
        <div className={styles.container}>
          <div className={styles.hint}>
            No resource was more saturated during the selection than baseline. Widen the selection, or pivot via the
            attribute comparison above.
          </div>
        </div>
      );
    }

    const fmt = (s: SaturationScore) =>
      s.signal.kind === 'utilization'
        ? `${Math.round(s.selectionValue * 100)}% during selection vs ${Math.round(s.baselineValue * 100)}% baseline (+${Math.round(s.score * 100)}pts)`
        : `${s.selectionValue.toFixed(1)} during selection vs ${s.baselineValue.toFixed(1)} baseline (×${(s.selectionValue / Math.max(s.baselineValue, 1e-6)).toFixed(1)})`;

    return (
      <div className={styles.container}>
        <div className={styles.title}>Infra saturation during selection</div>
        {scores.map((s) => (
          <div key={`${s.service}|${s.pod}|${s.signal.metricName}`} className={styles.card}>
            <div className={styles.cardHeader}>
              <span className={styles.resource}>
                {s.service} · {s.pod} · {s.signal.label}
                {s.lowConfidence ? ' (low sample — max shown)' : ''}
              </span>
              <span className={styles.delta}>{fmt(s)}</span>
            </div>
            <div className={styles.actions}>
              <Button size="sm" variant="secondary" icon="filter" onClick={() => model.filterToPod(s.pod)}>
                Filter to {s.pod}
              </Button>
              <Button size="sm" variant="secondary" icon="crosshair" onClick={() => model.focusService(s.service)}>
                Focus {s.service}
              </Button>
              <Button size="sm" variant="secondary" icon="graph-bar" onClick={() => model.viewSignals(s.service, s.pod)}>
                View signals
              </Button>
            </div>
          </div>
        ))}
      </div>
    );
  };
}

const getStyles = (theme: GrafanaTheme2) => ({
  container: css({
    padding: theme.spacing(1),
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(1),
  }),
  title: css({
    fontSize: theme.typography.h5.fontSize,
    fontWeight: theme.typography.fontWeightMedium,
  }),
  hint: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
    padding: theme.spacing(1),
  }),
  card: css({
    background: theme.colors.background.secondary,
    borderRadius: theme.shape.radius.default,
    padding: theme.spacing(1),
  }),
  cardHeader: css({
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: theme.spacing(1),
    marginBottom: theme.spacing(0.5),
  }),
  resource: css({
    fontWeight: theme.typography.fontWeightMedium,
  }),
  delta: css({
    color: theme.colors.text.secondary,
    fontSize: theme.typography.bodySmall.fontSize,
  }),
  actions: css({
    display: 'flex',
    gap: theme.spacing(0.5),
  }),
});
```

- [ ] **Step 4: Shim + exports**

Create `plugins/heatmap-app/src/components/Bubbles/SaturationPanel.ts`:

```ts
export { SaturationPanel } from '@heatmap/shared-comparison';
```

Append to `packages/shared-comparison/src/index.ts`:

```ts
export { SaturationPanel, parseComparisonFrames } from './SaturationPanel';
export type { SaturationPanelConfig } from './SaturationPanel';
```

- [ ] **Step 5: Run tests, verify they pass**

```bash
npm run test:ci --workspace=plugins/heatmap-app
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/shared-comparison/src/SaturationPanel.tsx packages/shared-comparison/src/index.ts plugins/heatmap-app/src/saturationParse.test.ts plugins/heatmap-app/src/components/Bubbles/SaturationPanel.ts
git commit -m "feat: saturation cards panel with actions and actionable empty states"
```

---

### Task 8: Workbench wiring — strip, sections, detail panel (campaign P4)

**Files:**
- Modify: `plugins/heatmap-app/src/pages/Bubbles/bubblesScene.ts`

**Interfaces:**
- Consumes: `SaturationPanel` (Task 7), `buildResourceSeriesSql`/`buildResourceDetailSql` (Task 5), existing `selectionState`/`serviceVar`/`adHocFilters` wiring.

- [ ] **Step 1: Add imports**

In `plugins/heatmap-app/src/pages/Bubbles/bubblesScene.ts`, extend the shared-comparison import (line 23) and add the panel import after line 22:

```ts
import { SaturationPanel } from '../../components/Bubbles/SaturationPanel';
import {
  InvestigationGuidancePanel,
  buildFilterClause,
  buildResourceSeriesSql,
  buildResourceDetailSql,
} from '@heatmap/shared-comparison';
```

(Replace the existing `import { InvestigationGuidancePanel, buildFilterClause } from '@heatmap/shared-comparison';` line.)

- [ ] **Step 2: Add the strip query + helper**

Inside `bubblesScene()`, after the `heatmapQuery` block (line ~110), add:

```ts
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
```

- [ ] **Step 3: Add the saturation panel + resource detail panel**

After the `representativeTracesPanel` block (line ~134), add:

```ts
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
```

- [ ] **Step 4: Wire saturation into the existing subscriptions**

(a) In the `selectionState.addActivationHandler` callback (line ~141), after `representativeTracesPanel.setSelection(newState.selection);` add:

```ts
        saturationPanel.setSelection(newState.selection);
```

(b) In the `adHocFilters.addActivationHandler` callback (line ~151), after the `representativeTracesPanel` re-run block add:

```ts
        if (saturationPanel.state.selection) {
          saturationPanel.setSelection(saturationPanel.state.selection);
        }
```

(c) In the `serviceVar.addActivationHandler` callback (line ~166), after `refreshHeatmapQuery();` add:

```ts
        refreshStripQuery();
```

and after the `representativeTracesPanel` re-run block add:

```ts
        if (saturationPanel.state.selection) {
          saturationPanel.setSelection(saturationPanel.state.selection);
        }
```

- [ ] **Step 5: Add sections and ordering**

After the `comparisonSection` block (line ~249), add:

```ts
  const stripSection = new SceneFlexItem({
    height: 90,
    body: new VizPanel({
      title: 'Infra saturation (max utilization, in-view services)',
      pluginId: 'timeseries',
      $data: stripQuery,
      fieldConfig: { defaults: { unit: 'percentunit', min: 0, max: 1, custom: {} }, overrides: [] } as any,
      options: { legend: { showLegend: false } } as any,
    }),
  });
  const saturationSection = new SceneFlexItem({
    minHeight: 140,
    body: saturationPanel,
  });
```

Replace the `orderedSections` assignment (lines ~251-256) with (strip rides directly under the heatmap in every view; saturation evidence and the hidden detail panel go last):

```ts
  const orderedSections: SceneFlexItem[] =
    view === 'comparisons'
      ? [guidanceSection, comparisonSection, heatmapSection, stripSection, tracesSection, saturationSection, resourceDetailSection]
      : view === 'evidence'
        ? [guidanceSection, tracesSection, comparisonSection, heatmapSection, stripSection, saturationSection, resourceDetailSection]
        : [guidanceSection, heatmapSection, stripSection, tracesSection, comparisonSection, saturationSection, resourceDetailSection];
```

- [ ] **Step 6: Typecheck, lint, tests, build**

```bash
npm run typecheck --workspace=plugins/heatmap-app && npm run lint --workspace=plugins/heatmap-app && npm run test:ci --workspace=plugins/heatmap-app && npm run build --workspace=plugins/heatmap-app
```

Expected: all clean. (`as any` on raw query objects is the existing house pattern — bubblesScene.ts:79.)

- [ ] **Step 7: GATE P4 — both states in the browser**

```bash
docker compose -f docker/docker-compose.yml restart grafana
```

Hard-refresh the browser (the `make up` cache-bust is a known no-op), open `http://localhost:3000/a/jordo-heatmap-bubbles-app/explorer`, then verify:

1. **Metrics flowing:** strip visible under the heatmap showing elevated max-utilization (search-service pins it ≥0.85); switch to errors mode, box-select a 503 burst on `/api/auth` spans → saturation cards appear; top card is `user-service · pod-abc-7|8 · Memory` with numbers consistent with Task 6; "Filter to pod-abc-7" adds the ad-hoc chip and re-runs everything; "Focus user-service" narrows the service; "View signals" reveals the resource detail timeseries.
2. **Metrics absent:** set the dashboard time range to a window BEFORE metrics existed (e.g. yesterday) and re-select → cards section shows the actionable empty state; heatmap/comparison/traces all still work.

- [ ] **Step 8: Commit**

```bash
git add plugins/heatmap-app/src/pages/Bubbles/bubblesScene.ts
git commit -m "feat: saturation strip, cards section, and resource detail in bubbles workbench"
```

---

### Task 9: Promotion — changeset, checklist, PR (campaign P5)

**Files:**
- Create: `.changeset/saturation-wide-events.md`
- Modify: `.claude/skills/heatmap-saturation-campaign/SKILL.md` (provenance refresh — edit only, see Step 3)

- [ ] **Step 1: Changeset**

Create `.changeset/saturation-wide-events.md`:

```markdown
---
'heatmap-app': minor
---

Saturation via wide events: box-select now also answers "was the infra saturated?" — ranked
resource cards (p95 during selection vs baseline, straight off raw OTel metric rows in
ClickHouse) plus an ambient saturation strip under the heatmap. No metrics store, no
dashboards, no new services — just SQL over wide events.
```

(Verify the package name first: `grep '"name"' plugins/heatmap-app/package.json` — use exactly that string.)

- [ ] **Step 2: Full pre-merge checklist (CI does not cover Go — run everything locally)**

```bash
npm run build && npm run typecheck && npm run lint && npm run test:ci
cd trace-generator && go test ./... && cd ..
cd services/slo-control-plane && go test ./... && cd ..
```

Expected: every command exits 0.

- [ ] **Step 3: Refresh the campaign skill's drifted facts**

In `.claude/skills/heatmap-saturation-campaign/SKILL.md`: (a) P0.2's "expect empty" baseline is now stale — note metrics tables exist as of this PR; (b) the provenance grep for `scenarioAuthMemoryLeakErrorRate` → constant renamed to `scenarioAuthMemoryLeakErrorRateInEpisode`/`OffEpisode` in `trace-generator/metrics.go`. Edit the file. Stage it ONLY if `.claude/skills` is already git-tracked (`git ls-files .claude | head -1` non-empty); otherwise leave the edit uncommitted for the maintainer.

- [ ] **Step 4: Commit and push**

```bash
git add .changeset/saturation-wide-events.md
git commit -m "chore: changeset for saturation via wide events"
git push -u origin feat/saturation-experiments
```

- [ ] **Step 5: Open the PR (base: main)**

Body must contain, in this order: (1) the scripted end-to-end walkthrough — `make up` → explorer URL → errors mode → strip shows search-service pressure → select S5 503 burst → memory card ranks first → filter to pod-abc-7 → representative traces confirm — each step with its expected observation; (2) the recorded numbers from `/tmp/saturation-gate-notes.md`: predicted band vs measured delta, gate query latency (Approach B's tripwire), collector version validated against (Task 1 Step 2); (3) the two carried-forward ceilings, verbatim: service-level join misses non-service infra (upgrade: span-side resource enrichment); p95-delta scoring is deliberately naive (upgrade: effect-size normalization, frontier work); (4) note that S5 503s changed from uniform 10% to episodic (weighted avg 8.8%) and why.

```bash
gh pr create --base main --title "Saturation via wide events" --body-file /tmp/saturation-pr-body.md
```

---

## Self-review notes (already applied)

- Spec coverage: campaign P0→P5 all mapped (P0/P1→Task 1, P2→Tasks 2-3, P3→Tasks 4-6, P4→Tasks 7-8, P5→Task 9). Approach B/C stay unbuilt by design; A2 latency obligation lands in Task 6 Step 4.
- Type consistency: `ResourceComparisonRow` field names match between `saturation.ts`, `parseComparisonFrames`, and the SQL column order contract stated in both Task 5 and Task 7.
- The `scenarioAuthMemoryLeakErrorRate` deletion (Task 3) deliberately alters a pinned test with the derivation shown — this is the documented exception, not a casual red-to-green edit.
