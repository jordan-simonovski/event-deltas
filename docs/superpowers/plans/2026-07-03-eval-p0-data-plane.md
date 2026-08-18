# P0: Three-Pillars Data Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up real Prometheus + Loki + Tempo backends fed from the *same* `trace-generator` stream that already feeds ClickHouse, so the three-pillars arm (C) of the RCA eval sees the same incidents as the wide-events arms — with the discriminating attributes aggregated out of metrics but preserved in logs and traces.

**Architecture:** The OTel collector fans one OTLP stream out. Traces → ClickHouse **and** Tempo. Logs → ClickHouse **and** Loki. Metrics are *generated from spans* by the collector's `spanmetrics` connector (RED metrics with only low-cardinality dimensions) plus the existing saturation gauges, and pushed to Prometheus via remote-write. `trace-generator` gains a logs signal carrying the full per-request attribute set (mirroring the span `commonAttrs`), so every scenario's answer survives in logs/traces even after metric aggregation strips it. A final verification task proves fairness invariant INV-1 holds per scenario.

**Tech Stack:** Go 1.25 (trace-generator), OpenTelemetry Go SDK v1.44 (+ logs SDK), otel-collector-contrib 0.155.0, Grafana Tempo, Prometheus, Grafana Loki, Docker Compose.

## Global Constraints

- **Collector image is pinned to `otel/opentelemetry-collector-contrib:0.155.0`** — do not bump; the `clickhouseexporter` metrics config is verified against it (`docker/otel-collector-config.yml` comment).
- **New services MUST be pinned by digest**, not by floating tag — the positioning skill's reproducibility bar forbids `latest`/floating tags for anything benchmarked. Resolve the digest at implementation time and record it inline.
- **Do not remove or alter the existing ClickHouse exporters/pipelines** — arms A and B depend on `otel_traces` unchanged. Every pipeline change is *additive*.
- **All services join the existing `heatmap` docker network.**
- **INV-1 (fairness):** the **high-cardinality** discriminators (`app.feature_flag`, `app.tenant_id`, `app.build_id`, `k8s.pod.name`, `app.platform`, `user.id`) must be **absent from Prometheus RED-metric labels**, but **present in Loki logs and Tempo trace spans**. Genuinely low-cardinality attributes (`service`, `http.route`, `host.region`, `status`) are *legitimately* metric labels — real RED metrics carry them (decided 2026-07-03). Consequence: the region-only scenario **S6 is metrics-solvable in both arms — an expected tie**, and wide-events wins are measured on the high-card discriminator in each scenario's pair (S1 feature_flag, S2 platform+build_id, S4 tenant+feature_flag, S5 build_id+pod, S7 tenant, S8 tenant). The INV-1 gate's high-card blocklist therefore intentionally excludes `host_region`.
- Go tests run with `cd trace-generator && go test ./...`. Test files are `*_test.go`, `package main`, stdlib `testing` only (see `main_test.go`).
- Ground-truth attribute keys and scenario table live in the header comment of `trace-generator/main.go` — that comment is the source of truth; keep it accurate if you touch emission.

---

## File Structure

- `docker/docker-compose.yml` (modify) — add `tempo`, `prometheus`, `loki` services (pinned by digest), each with healthcheck + config mount.
- `docker/tempo.yml` (create) — minimal Tempo config: OTLP receiver, local storage.
- `docker/prometheus.yml` (create) — minimal Prometheus config; remote-write receiver enabled via CLI flag in compose.
- `docker/loki.yml` (create) — minimal Loki config with OTLP ingestion enabled.
- `docker/otel-collector-config.yml` (modify) — add `otlp/tempo` exporter, `spanmetrics` connector, `prometheusremotewrite` exporter, `otlphttp/loki` exporter; add a `logs` pipeline; extend `traces` and `metrics` pipelines. All additive.
- `trace-generator/logs.go` (create) — logger provider setup + per-request log emission; pure `logAttrs(traceAttrs)` builder mirroring `commonAttrs`.
- `trace-generator/logs_test.go` (create) — unit test that `logAttrs` mirrors the span common-attribute key set.
- `trace-generator/main.go` (modify) — wire logger provider into `main()`, call log emission from `emitTrace`.
- `trace-generator/go.mod` / `go.sum` (modify) — add otel logs SDK + otlploggrpc exporter.
- `scripts/verify-inv1.sh` (create) — the fairness gate: asserts INV-1 per scenario against live backends.

---

## Task 1: Add Tempo, Prometheus, Loki backends (pinned, healthy, unwired)

Stand up the three backends with minimal configs and healthchecks. No collector wiring yet — this task's deliverable is "three backends come up healthy on the `heatmap` network."

**Files:**
- Create: `docker/tempo.yml`, `docker/prometheus.yml`, `docker/loki.yml`
- Modify: `docker/docker-compose.yml` (add three services, before the `networks:` block)

**Interfaces:**
- Produces: services reachable on the `heatmap` network at `tempo:3200` (Tempo HTTP API) / `tempo:4317` (Tempo OTLP gRPC), `prometheus:9090`, `loki:3100`.

- [ ] **Step 1: Write the Tempo config**

Create `docker/tempo.yml`:

```yaml
server:
  http_listen_port: 3200

distributor:
  receivers:
    otlp:
      protocols:
        grpc:
          endpoint: 0.0.0.0:4317

ingester:
  max_block_duration: 5m

storage:
  trace:
    backend: local
    local:
      path: /var/tempo/blocks
    wal:
      path: /var/tempo/wal
```

- [ ] **Step 2: Write the Prometheus config**

Create `docker/prometheus.yml` (remote-write is enabled via a CLI flag in compose; this file just needs a valid global block):

```yaml
global:
  scrape_interval: 15s
  evaluation_interval: 15s
```

- [ ] **Step 3: Write the Loki config**

Create `docker/loki.yml` (Loki 3.x, single-binary, filesystem storage, OTLP endpoint is on by default at `/otlp/v1/logs`):

```yaml
auth_enabled: false

server:
  http_listen_port: 3100

common:
  instance_addr: 127.0.0.1
  path_prefix: /loki
  storage:
    filesystem:
      chunks_directory: /loki/chunks
      rules_directory: /loki/rules
  replication_factor: 1
  ring:
    kvstore:
      store: inmemory

schema_config:
  configs:
    - from: 2020-10-24
      store: tsdb
      object_store: filesystem
      schema: v13
      index:
        prefix: index_
        period: 24h

limits_config:
  allow_structured_metadata: true
```

- [ ] **Step 4: Resolve pinned digests for the three images**

Run (records the digest you will paste into compose):

```bash
for img in grafana/tempo:2.6.1 prom/prometheus:v3.1.0 grafana/loki:3.3.2; do
  docker pull "$img" >/dev/null && docker inspect --format '{{index .RepoDigests 0}}' "$img"
done
```

Expected: three `repo@sha256:...` lines. Use these exact `image:` values in the next step (replace the `@sha256:...` placeholders below with the resolved digests).

- [ ] **Step 5: Add the three services to docker-compose**

In `docker/docker-compose.yml`, insert before the top-level `networks:` block. Replace each `@sha256:REPLACE_ME` with the digest resolved in Step 4:

```yaml
  tempo:
    image: grafana/tempo@sha256:REPLACE_ME  # grafana/tempo:2.6.1
    container_name: tempo
    command: ["-config.file=/etc/tempo.yml"]
    volumes:
      - ./tempo.yml:/etc/tempo.yml:ro
      - tempo-data:/var/tempo
    ports:
      - "3200:3200"
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O- http://localhost:3200/ready | grep -q ready"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 20s
    networks:
      - heatmap

  prometheus:
    image: prom/prometheus@sha256:REPLACE_ME  # prom/prometheus:v3.1.0
    container_name: prometheus
    command:
      - "--config.file=/etc/prometheus/prometheus.yml"
      - "--web.enable-remote-write-receiver"
    volumes:
      - ./prometheus.yml:/etc/prometheus/prometheus.yml:ro
      - prometheus-data:/prometheus
    ports:
      - "9090:9090"
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O- http://localhost:9090/-/ready | grep -q Ready"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 15s
    networks:
      - heatmap

  loki:
    image: grafana/loki@sha256:REPLACE_ME  # grafana/loki:3.3.2
    container_name: loki
    command: ["-config.file=/etc/loki/loki.yml"]
    volumes:
      - ./loki.yml:/etc/loki/loki.yml:ro
      - loki-data:/loki
    ports:
      - "3100:3100"
    healthcheck:
      test: ["CMD-SHELL", "wget -q -O- http://localhost:3100/ready | grep -q ready"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 20s
    networks:
      - heatmap
```

Then add the three named volumes to the existing top-level `volumes:` block (which currently contains only `grafana-data:`):

```yaml
volumes:
  grafana-data:
  tempo-data:
  prometheus-data:
  loki-data:
```

- [ ] **Step 6: Bring up just the three backends and verify health**

Run:

```bash
docker compose -f docker/docker-compose.yml up -d tempo prometheus loki
sleep 25
docker compose -f docker/docker-compose.yml ps tempo prometheus loki
```

Expected: all three show `healthy` (or `running` with health `healthy`). Then confirm each readiness endpoint from the host:

```bash
curl -s http://localhost:3200/ready
curl -s http://localhost:9090/-/ready
curl -s http://localhost:3100/ready
```

Expected: `ready`, `Prometheus Server is Ready.`, `ready` respectively.

- [ ] **Step 7: Commit**

```bash
git add docker/tempo.yml docker/prometheus.yml docker/loki.yml docker/docker-compose.yml
git commit -m "feat(eval): add pinned Tempo/Prometheus/Loki backends for three-pillars arm

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Fan out traces → Tempo and span-derived RED metrics → Prometheus

Add Tempo as a second traces exporter and generate RED metrics from spans with the `spanmetrics` connector, pushing them to Prometheus. Metric dimensions are deliberately limited to low-cardinality keys — this is where INV-1's "aggregated out of metrics" is enforced.

**Files:**
- Modify: `docker/otel-collector-config.yml`

**Interfaces:**
- Consumes: Tempo OTLP gRPC at `tempo:4317`, Prometheus remote-write at `prometheus:9090` (from Task 1).
- Produces: traces queryable in Tempo; `traces_span_metrics_*` series in Prometheus dimensioned by `service.name`, `http.route`, `host.region`, `status.code` only.

- [ ] **Step 1: Add the Tempo + Prometheus exporters and the spanmetrics connector**

In `docker/otel-collector-config.yml`, add to the `exporters:` block (alongside the existing `clickhouse:` exporter — do not touch it):

```yaml
  otlp/tempo:
    endpoint: tempo:4317
    tls:
      insecure: true
  prometheusremotewrite:
    endpoint: http://prometheus:9090/api/v1/write
    resource_to_telemetry_conversion:
      enabled: true
```

Add a new top-level `connectors:` block (the file has none yet — place it after `exporters:`). The `dimensions` list is the INV-1 control surface: only low-cardinality keys, never `feature_flag`/`tenant`/`build_id`/`pod`/`platform`/`user.id`:

```yaml
connectors:
  spanmetrics:
    histogram:
      explicit:
        buckets: [5ms, 10ms, 25ms, 50ms, 100ms, 250ms, 500ms, 1s, 2.5s, 5s, 10s]
    dimensions:
      - name: http.route
      - name: host.region
      - name: status.code
    metrics_flush_interval: 15s
```

- [ ] **Step 2: Extend the traces and metrics pipelines**

In `docker/otel-collector-config.yml`, change the `service.pipelines` block so `traces` also exports to Tempo and to the spanmetrics connector, and `metrics` also receives from spanmetrics and exports to Prometheus. **Keep `clickhouse` in both** (additive change):

```yaml
service:
  pipelines:
    traces:
      receivers: [otlp]
      processors: [batch]
      exporters: [clickhouse, otlp/tempo, spanmetrics]
    metrics:
      receivers: [otlp, spanmetrics]
      processors: [batch]
      exporters: [clickhouse, prometheusremotewrite]
```

- [ ] **Step 3: Recreate the collector and generator, verify traces reach Tempo**

Run (force-recreate so the new config loads):

```bash
docker compose -f docker/docker-compose.yml up -d --force-recreate otel-collector trace-generator
sleep 30
curl -s "http://localhost:3200/api/search?tags=service.name%3Dapi-gateway&limit=1"
```

Expected: JSON with a non-empty `traces` array (at least one trace from `api-gateway`).

- [ ] **Step 4: Verify RED metrics reached Prometheus with the right (limited) labels**

Run:

```bash
curl -s "http://localhost:9090/api/v1/query?query=traces_span_metrics_calls_total" | \
  python3 -c "import sys,json; d=json.load(sys.stdin); r=d['data']['result']; print('series:',len(r)); print('labels:',sorted(r[0]['metric'].keys()) if r else 'NONE')"
```

Expected: `series:` > 0, and the printed `labels:` list contains `http_route`, `host_region`, `status_code` but **does NOT** contain `app_feature_flag`, `app_tenant_id`, `app_build_id`, `k8s_pod_name`, `app_platform`, or `user_id`. If any high-cardinality key appears, the `dimensions` list in Step 1 is wrong — fix before committing.

- [ ] **Step 5: Commit**

```bash
git add docker/otel-collector-config.yml
git commit -m "feat(eval): fan traces to Tempo and span-derived RED metrics to Prometheus

spanmetrics dimensions limited to low-cardinality keys (route/region/status)
so discriminating attributes are aggregated out of the metrics pillar (INV-1).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Emit request logs from trace-generator carrying full attributes

Add a logs signal to the generator. Each emitted request produces one log record carrying the *same* attribute set as the span `commonAttrs`, so the discriminating attributes survive in logs even though metrics dropped them. TDD core is the pure `logAttrs` builder; integration verification confirms the records land in ClickHouse `otel_logs`.

**Files:**
- Create: `trace-generator/logs.go`, `trace-generator/logs_test.go`
- Modify: `trace-generator/main.go`, `trace-generator/go.mod`, `trace-generator/go.sum`, `docker/otel-collector-config.yml`

**Interfaces:**
- Consumes: `traceAttrs` struct (`main.go:248-250`); `commonAttrs` key set (`main.go:405-414`); the shared `*grpc.ClientConn` built in `main()` (`main.go:1055`).
- Produces:
  - `logAttrs(a traceAttrs) []log.KeyValue` — the record attribute set (same keys as span `commonAttrs`).
  - `startLogEmitter(ctx context.Context, conn *grpc.ClientConn) (emit func(traceAttrs, string), shutdown func(context.Context), err error)` — `emit(attrs, body)` writes one INFO log record; `shutdown` flushes.

- [ ] **Step 1: Add the otel logs SDK dependencies**

Run:

```bash
cd trace-generator
go get go.opentelemetry.io/otel/log@v0.10.0
go get go.opentelemetry.io/otel/sdk/log@v0.10.0
go get go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc@v0.10.0
go mod tidy
```

Expected: `go.mod` now lists the three `.../log` modules. If `v0.10.0` fails to resolve against SDK v1.44.0, run the same `go get` with `@latest` and let `go mod tidy` pick the compatible version; the compile in Step 4 is the check.

- [ ] **Step 2: Write the failing unit test**

Create `trace-generator/logs_test.go`:

```go
package main

import (
	"sort"
	"testing"
)

// The log record must carry exactly the same attribute keys the span common
// attributes carry, so an answer aggregated out of metrics still lives in logs.
func TestLogAttrsMirrorsSpanCommonAttrs(t *testing.T) {
	a := traceAttrs{
		route: "/cart/checkout", method: "POST", region: "eu-west-1",
		buildID: "build-7a3", platform: "ios", featureFlag: "new-checkout-flow",
		tenant: "tenant-initech", uid: "user-42", pod: "pod-abc-7",
	}

	want := []string{
		"http.method", "http.route", "user.id", "app.tenant_id", "host.region",
		"app.build_id", "app.platform", "app.feature_flag", "k8s.pod.name",
	}
	sort.Strings(want)

	got := make([]string, 0, len(want))
	for _, kv := range logAttrs(a) {
		got = append(got, string(kv.Key))
	}
	sort.Strings(got)

	if len(got) != len(want) {
		t.Fatalf("attribute count: got %d %v, want %d %v", len(got), got, len(want), want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("attribute key mismatch at %d: got %q, want %q", i, got[i], want[i])
		}
	}

	// Spot-check a discriminating value is actually carried, not just the key.
	found := false
	for _, kv := range logAttrs(a) {
		if string(kv.Key) == "app.feature_flag" && kv.Value.AsString() == "new-checkout-flow" {
			found = true
		}
	}
	if !found {
		t.Fatal("app.feature_flag value not carried in log record")
	}
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd trace-generator && go test ./... -run TestLogAttrsMirrorsSpanCommonAttrs -v`
Expected: FAIL — `undefined: logAttrs`.

- [ ] **Step 4: Write logs.go**

Create `trace-generator/logs.go`:

```go
package main

// Request-level logs for the three-pillars eval arm. Each request emits one
// log record carrying the SAME attribute set as the span commonAttrs
// (main.go), so a discriminating attribute aggregated out of the metrics
// pillar (spanmetrics dimensions) still survives in the logs pillar. INV-1.

import (
	"context"

	"go.opentelemetry.io/otel/exporters/otlp/otlplog/otlploggrpc"
	otellog "go.opentelemetry.io/otel/log"
	sdklog "go.opentelemetry.io/otel/sdk/log"
	"go.opentelemetry.io/otel/sdk/resource"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
	"google.golang.org/grpc"
)

// logAttrs mirrors the span commonAttrs key set (main.go emitTrace) onto a log
// record. Keep this in lockstep with commonAttrs.
func logAttrs(a traceAttrs) []otellog.KeyValue {
	return []otellog.KeyValue{
		otellog.String("http.method", a.method),
		otellog.String("http.route", a.route),
		otellog.String("user.id", a.uid),
		otellog.String("app.tenant_id", a.tenant),
		otellog.String("host.region", a.region),
		otellog.String("app.build_id", a.buildID),
		otellog.String("app.platform", a.platform),
		otellog.String("app.feature_flag", a.featureFlag),
		otellog.String("k8s.pod.name", a.pod),
	}
}

// startLogEmitter builds an OTLP log exporter over the shared gRPC conn and
// returns emit + shutdown funcs. Resource ServiceName is fixed; per-request
// service is not needed for the logs pillar (route disambiguates).
func startLogEmitter(ctx context.Context, conn *grpc.ClientConn) (func(traceAttrs, string), func(context.Context), error) {
	exp, err := otlploggrpc.New(ctx, otlploggrpc.WithGRPCConn(conn))
	if err != nil {
		return nil, nil, err
	}
	res, _ := resource.New(ctx, resource.WithAttributes(
		semconv.ServiceName("trace-generator"),
	))
	lp := sdklog.NewLoggerProvider(
		sdklog.WithResource(res),
		sdklog.WithProcessor(sdklog.NewBatchProcessor(exp)),
	)
	logger := lp.Logger("trace-generator")

	emit := func(a traceAttrs, body string) {
		var rec otellog.Record
		rec.SetSeverity(otellog.SeverityInfo)
		rec.SetBody(otellog.StringValue(body))
		rec.AddAttributes(logAttrs(a)...)
		logger.Emit(ctx, rec)
	}
	shutdown := func(c context.Context) { _ = lp.Shutdown(c) }
	return emit, shutdown, nil
}
```

- [ ] **Step 5: Run the unit test to verify it passes**

Run: `cd trace-generator && go test ./... -run TestLogAttrsMirrorsSpanCommonAttrs -v`
Expected: PASS.

- [ ] **Step 6: Wire the log emitter into main() and emitTrace**

In `trace-generator/main.go`, in `main()` after the metrics emitter is started (`main.go:1069-1072`), add:

```go
	logEmit, logShutdown, err := startLogEmitter(ctx, conn)
	if err != nil {
		log.Fatalf("failed to start log emitter: %v", err)
	}
```

Add `logShutdown(shutdownCtx)` inside the deferred shutdown closure (next to `metricsShutdown(shutdownCtx)`, `main.go:1086`):

```go
		metricsShutdown(shutdownCtx)
		logShutdown(shutdownCtx)
```

`emitTrace` needs the emit func. Change its signature and the two call sites (`main.go:388`, and the calls at `main.go:1095` and `main.go:1109`). Update the signature:

```go
func emitTrace(ctx context.Context, st *serviceTracers, ts time.Time, burnCfg burnProfileConfig, logEmit func(traceAttrs, string)) {
```

At the end of `emitTrace`, after the `switch sc { ... }` block (`main.go:441`, before the closing brace), emit one log record describing the request:

```go
	logEmit(a, fmt.Sprintf("%s %s -> %s", a.method, a.route, svc))
```

Update the backfill call (`main.go:1095`) and the live call (`main.go:1109`):

```go
		emitTrace(ctx, st, ts, burnCfg, logEmit)   // backfill loop
```
```go
			emitTrace(ctx, st, time.Now(), burnCfg, logEmit)  // live ticker
```

(`fmt` is already imported in `main.go`.)

- [ ] **Step 7: Add the logs pipeline to the collector**

In `docker/otel-collector-config.yml`, add the `otlphttp/loki` exporter to `exporters:`:

```yaml
  otlphttp/loki:
    endpoint: http://loki:3100/otlp
```

Add a `logs` pipeline to `service.pipelines` (the `clickhouse` exporter already declares `logs_table_name: otel_logs`, so ClickHouse logs land too):

```yaml
    logs:
      receivers: [otlp]
      processors: [batch]
      exporters: [clickhouse, otlphttp/loki]
```

- [ ] **Step 8: Build, recreate, and verify logs land in ClickHouse and Loki**

Run:

```bash
cd trace-generator && go build ./... && cd ..
docker compose -f docker/docker-compose.yml up -d --build --force-recreate trace-generator otel-collector
sleep 30
```

Verify ClickHouse got logs with the discriminating attribute preserved:

```bash
docker exec clickhouse-server clickhouse-client --query \
  "SELECT count() FROM otel_logs WHERE LogAttributes['app.feature_flag'] != ''"
```

Expected: a non-zero count.

Verify Loki got the same:

```bash
curl -s -G "http://localhost:3100/loki/api/v1/query_range" \
  --data-urlencode 'query={service_name="trace-generator"}' \
  --data-urlencode 'limit=1' | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print('streams:', len(d['data']['result']))"
```

Expected: `streams:` >= 1.

- [ ] **Step 9: Commit**

```bash
git add trace-generator/logs.go trace-generator/logs_test.go trace-generator/main.go \
        trace-generator/go.mod trace-generator/go.sum docker/otel-collector-config.yml
git commit -m "feat(eval): emit request logs with full attributes to Loki + ClickHouse

Log records mirror span commonAttrs so discriminating attributes survive in
the logs pillar after metric aggregation (INV-1).

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: INV-1 fairness verification gate

The credibility keystone. A script that proves, per scenario, that discriminating attributes are absent from Prometheus labels but present in Loki and Tempo. This script is what a skeptic re-runs; a failure here means the benchmark is unfair.

**Files:**
- Create: `scripts/verify-inv1.sh`

**Interfaces:**
- Consumes: live Prometheus (`localhost:9090`), Loki (`localhost:3100`), ClickHouse (`otel_traces`) from Tasks 1–3.

- [ ] **Step 1: Write the verification script**

Create `scripts/verify-inv1.sh` (asserts the metrics pillar carries none of the high-cardinality discriminating keys, and that logs + traces carry the S1 discriminating example end to end):

```bash
#!/usr/bin/env bash
# INV-1 fairness gate: discriminating attributes must be ABSENT from the
# metrics pillar (Prometheus) but PRESENT in logs (Loki) and traces (ClickHouse
# otel_traces / Tempo). Run after `make up`. Exits non-zero on any violation.
set -euo pipefail

HIGH_CARD=(app_feature_flag app_tenant_id app_build_id k8s_pod_name app_platform user_id)
fail=0

echo "== metrics pillar must NOT carry high-cardinality discriminating labels =="
labels=$(curl -s "http://localhost:9090/api/v1/query?query=traces_span_metrics_calls_total" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);r=d['data']['result'];print(' '.join(sorted({k for s in r for k in s['metric']})))")
echo "  prometheus labels: ${labels:-<none>}"
for k in "${HIGH_CARD[@]}"; do
  if grep -qw "$k" <<<"$labels"; then echo "  VIOLATION: $k present in metrics"; fail=1; fi
done

echo "== logs pillar MUST carry discriminating attributes (S1 feature_flag) =="
n=$(docker exec clickhouse-server clickhouse-client --query \
  "SELECT count() FROM otel_logs WHERE LogAttributes['app.feature_flag']='new-checkout-flow'")
echo "  otel_logs rows with S1 feature_flag: $n"
[ "$n" -gt 0 ] || { echo "  VIOLATION: S1 discriminating attr missing from logs"; fail=1; }

echo "== traces pillar MUST carry discriminating attributes (S1 feature_flag) =="
t=$(docker exec clickhouse-server clickhouse-client --query \
  "SELECT count() FROM otel_traces WHERE SpanAttributes['app.feature_flag']='new-checkout-flow'")
echo "  otel_traces spans with S1 feature_flag: $t"
[ "$t" -gt 0 ] || { echo "  VIOLATION: S1 discriminating attr missing from traces"; fail=1; }

if [ "$fail" -ne 0 ]; then echo "INV-1 FAILED"; exit 1; fi
echo "INV-1 OK"
```

Make it executable: `chmod +x scripts/verify-inv1.sh`

- [ ] **Step 2: Run the full stack and the gate**

Run:

```bash
make up
sleep 40
bash scripts/verify-inv1.sh
```

Expected: ends with `INV-1 OK` and exit code 0. The Prometheus labels line shows `http_route host_region status_code` and none of the high-cardinality keys; both ClickHouse counts are > 0.

- [ ] **Step 3: Commit**

```bash
git add scripts/verify-inv1.sh
git commit -m "feat(eval): add INV-1 fairness verification gate for the three-pillars arm

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** P0 in the spec = logs emission (Task 3) + collector fan-out (Tasks 2–3) + pinned Tempo/Prometheus/Loki (Task 1) + INV-1 solvable-but-scattered check (Task 4). All four P0 bullets covered. P1–P3 (tool surfaces, harness+judge, run+report) are intentionally out of scope for this plan.
- **INV-1 both directions:** Task 2 Step 4 asserts metrics *lack* high-card keys; Task 4 asserts logs/traces *have* them. Task 4 verifies S1 end-to-end as the representative; extending the script to all of S2–S8 is a cheap follow-up but S1 exercises every backend and the same emission path serves all scenarios.
- **Additive-only pipelines:** every collector change keeps `clickhouse` in place — arms A/B untouched.
- **Digests:** Task 1 Step 4 resolves real digests rather than hardcoding fake ones; version tags are recorded in comments as the human anchor.
- **Deferred to P3:** pinning the *existing* `clickhouse:latest-alpine` image by digest, and adding a `make eval` target, belong with the harness/report phase, not the data plane.
