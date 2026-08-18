/*
Trace Generator — synthetic traces for the event-deltas stack.

Emits ~50 traces/sec through an api-gateway root span, with downstream
service spans (order-service, user-service, search-service, payment-service,
notification-service). Each service gets its own TracerProvider so the
ClickHouse ServiceName column is populated correctly.

Backfills 10 minutes of history on startup, then streams live.

# Failure Scenarios

| ID | Name                          | Trigger Attributes                                                   | Symptom                              | Discover By                     |
|----|-------------------------------|----------------------------------------------------------------------|--------------------------------------|---------------------------------|
| S1 | Slow Checkout (Feature+Region)| route=/cart/checkout, flag=new-checkout-flow, region=eu-west-1       | p99 ~1500ms, N+1 queries            | feature_flag, region            |
| S2 | iOS Order Errors (Build)      | route=/api/orders, platform=ios, build=build-7a3                     | HTTP 500, ~250ms                     | platform, build_id              |
| S3 | Redis Timeout (APAC)          | user-svc routes, region=ap-southeast-1                               | p99 ~650ms, redis slow + pg fallback | region, db.system               |
| S4 | Initech Search Fail (Tenant)  | tenant=tenant-initech, flag=dark-launch-search, route=/api/search    | HTTP 500, ES timeout ~3s             | tenant_id, feature_flag         |
| S5 | Auth Memory Leak (Build+Pod)  | route=/api/auth, build=build-7a3, pod=pod-abc-{7,8}                  | p99 ~800ms, intermittent 503         | build_id, k8s.pod.name          |
| S6 | Payment Timeout (Region)      | route=/cart/checkout, region=us-west-2, ~5% prob                     | HTTP 504, ~5s timeout                | region                          |
| S7 | Umbrella EU Compliance        | tenant=tenant-umbrella, region=eu-west-1                             | +150ms overhead, all routes          | tenant_id, region               |
| S8 | Globex Batch Import           | tenant=tenant-globex, route=/api/products, method=POST               | Slow ES ~500ms                       | tenant_id, http.method          |
*/
package main

import (
	"context"
	"fmt"
	"log"
	"math/rand"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.24.0"
	"go.opentelemetry.io/otel/trace"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
)

// ── Weighted random helpers ─────────────────────────────────────────

type weightedChoice struct {
	value  string
	weight float64
}

func pickWeighted(choices []weightedChoice) string {
	total := 0.0
	for _, c := range choices {
		total += c.weight
	}
	r := rand.Float64() * total
	for _, c := range choices {
		r -= c.weight
		if r <= 0 {
			return c.value
		}
	}
	return choices[len(choices)-1].value
}

func pickUniform(choices []string) string {
	return choices[rand.Intn(len(choices))]
}

func gaussianDuration(mean, stddev float64) time.Duration {
	d := mean + rand.NormFloat64()*stddev
	if d < 1 {
		d = 1
	}
	return time.Duration(d * float64(time.Millisecond))
}

func markSpanError(span trace.Span, exceptionType, message string) {
	span.SetStatus(codes.Error, message)
	span.AddEvent("exception",
		trace.WithAttributes(
			attribute.String("exception.type", exceptionType),
			attribute.String("exception.message", message),
		),
	)
}

// ── Attribute pools ─────────────────────────────────────────────────

var (
	routes = []weightedChoice{
		{"/api/users", 25},
		{"/api/orders", 15},
		{"/cart/checkout", 10},
		{"/api/search", 25},
		{"/api/products", 15},
		{"/api/auth", 10},
	}

	methods = []weightedChoice{
		{"GET", 60},
		{"POST", 25},
		{"PUT", 10},
		{"DELETE", 5},
	}

	regions = []weightedChoice{
		{"us-east-1", 40},
		{"us-west-2", 30},
		{"eu-west-1", 20},
		{"ap-southeast-1", 10},
	}

	buildIDs = []weightedChoice{
		{"build-7a1", 35},
		{"build-7a2", 35},
		{"build-7a3", 30},
	}

	platforms = []weightedChoice{
		{"web", 50},
		{"ios", 30},
		{"android", 20},
	}

	featureFlags = []weightedChoice{
		{"new-checkout-flow", 15},
		{"dark-launch-search", 10},
		{"legacy", 75},
	}

	tenants  = []string{"tenant-acme", "tenant-globex", "tenant-initech", "tenant-umbrella"}
	podNames []string
)

func init() {
	for i := 1; i <= 8; i++ {
		podNames = append(podNames, fmt.Sprintf("pod-abc-%d", i))
	}
}

func userID() string {
	return fmt.Sprintf("user-%04d", rand.Intn(500)+1)
}

// ── Service mapping ─────────────────────────────────────────────────

func routeToService(route string) string {
	switch route {
	case "/api/orders", "/cart/checkout":
		return "order-service"
	case "/api/users", "/api/auth":
		return "user-service"
	case "/api/search", "/api/products":
		return "search-service"
	default:
		return "unknown-service"
	}
}

func serviceToDBSystem(svc string) string {
	switch svc {
	case "order-service":
		return "postgres"
	case "user-service":
		return "postgres"
	case "search-service":
		return "elasticsearch"
	default:
		return "none"
	}
}

// ── Per-service TracerProviders ──────────────────────────────────────
//
// Each service gets its own TracerProvider so the ClickHouse ServiceName
// column is populated from the resource attribute, not a span attribute.

type serviceTracers struct {
	providers map[string]*sdktrace.TracerProvider
	tracers   map[string]trace.Tracer
}

func newServiceTracers(ctx context.Context, exporter sdktrace.SpanExporter) *serviceTracers {
	names := []string{
		"api-gateway",
		"order-service",
		"user-service",
		"search-service",
		"payment-service",
		"notification-service",
	}
	st := &serviceTracers{
		providers: make(map[string]*sdktrace.TracerProvider, len(names)),
		tracers:   make(map[string]trace.Tracer, len(names)),
	}
	for _, name := range names {
		res, _ := resource.New(ctx,
			resource.WithAttributes(
				semconv.ServiceName(name),
				semconv.ServiceVersion("1.0.0"),
			),
		)
		tp := sdktrace.NewTracerProvider(
			sdktrace.WithBatcher(exporter,
				sdktrace.WithMaxExportBatchSize(512),
				sdktrace.WithBatchTimeout(2*time.Second),
			),
			sdktrace.WithResource(res),
		)
		st.providers[name] = tp
		st.tracers[name] = tp.Tracer("trace-generator")
	}
	return st
}

func (st *serviceTracers) tracer(name string) trace.Tracer {
	return st.tracers[name]
}

func (st *serviceTracers) shutdown(ctx context.Context) {
	for _, tp := range st.providers {
		_ = tp.Shutdown(ctx)
	}
}

// ── Scenario detection ──────────────────────────────────────────────

type scenario int

const (
	scenarioNormal             scenario = iota
	scenarioSlowCheckout                // S1
	scenarioIOSOrderErrors              // S2
	scenarioRedisTimeoutAPAC            // S3
	scenarioInitechSearch               // S4
	scenarioAuthMemoryLeak              // S5
	scenarioPaymentTimeout              // S6
	scenarioUmbrellaCompliance          // S7
	scenarioGlobexBatch                 // S8
)

type traceAttrs struct {
	route, method, region, buildID, platform, featureFlag, tenant, uid, pod string
}

const (
	// Keep local dev data mostly healthy so alert calibration can be validated.
	// High values here quickly force sustained breach conditions for 99% SLOs.
	scenarioPaymentTimeoutRate = 0.05
)

type burnProfileMode string

const (
	burnProfileNone          burnProfileMode = "none"
	burnProfileDeterministic burnProfileMode = "deterministic"
)

type burnLevel string

const (
	burnLevelSlow  burnLevel = "slow"
	burnLevelSteep burnLevel = "steep"
)

type burnProfileConfig struct {
	Mode           burnProfileMode
	SteepRoute     string
	SteepErrorRate float64
	SlowRoute      string
	SlowErrorRate  float64
}

func loadBurnProfileConfigFromEnv() burnProfileConfig {
	mode := burnProfileMode(strings.ToLower(strings.TrimSpace(os.Getenv("BURN_PROFILE"))))
	if mode == "" {
		mode = burnProfileNone
	}
	return burnProfileConfig{
		Mode:           mode,
		SteepRoute:     stringEnv("BURN_STEEP_ROUTE", "/cart/checkout"),
		SteepErrorRate: boundedFloatEnv("BURN_STEEP_ERROR_RATE", 0.003),
		SlowRoute:      stringEnv("BURN_SLOW_ROUTE", "/api/auth"),
		SlowErrorRate:  boundedFloatEnv("BURN_SLOW_ERROR_RATE", 0.001),
	}
}

func stringEnv(key, fallback string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	return v
}

func boundedFloatEnv(key string, fallback float64) float64 {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	n, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return fallback
	}
	if n < 0 {
		return 0
	}
	if n > 1 {
		return 1
	}
	return n
}

func deterministicBurnDecision(route string, cfg burnProfileConfig, sample float64) (int, burnLevel, bool) {
	if cfg.Mode != burnProfileDeterministic {
		return 0, "", false
	}
	if route == cfg.SteepRoute && sample < cfg.SteepErrorRate {
		return 504, burnLevelSteep, true
	}
	if route == cfg.SlowRoute && sample < cfg.SlowErrorRate {
		return 503, burnLevelSlow, true
	}
	return 0, "", false
}

func detectScenario(a traceAttrs) scenario {
	svc := routeToService(a.route)

	// S6: Payment timeout — checkout + us-west-2, limited probability gate
	if a.route == "/cart/checkout" && a.region == "us-west-2" && rand.Float64() < scenarioPaymentTimeoutRate {
		return scenarioPaymentTimeout
	}
	// S1: Slow checkout — feature flag + EU
	if a.route == "/cart/checkout" && a.featureFlag == "new-checkout-flow" && a.region == "eu-west-1" {
		return scenarioSlowCheckout
	}
	// S2: iOS order errors — bad build
	if a.route == "/api/orders" && a.platform == "ios" && a.buildID == "build-7a3" {
		return scenarioIOSOrderErrors
	}
	// S4: Initech search failure — tenant + dark-launch flag
	if a.tenant == "tenant-initech" && a.featureFlag == "dark-launch-search" && a.route == "/api/search" {
		return scenarioInitechSearch
	}
	// S5: Auth memory leak — build + specific pods
	if a.route == "/api/auth" && a.buildID == "build-7a3" && (a.pod == "pod-abc-7" || a.pod == "pod-abc-8") {
		return scenarioAuthMemoryLeak
	}
	// S3: Redis timeout — APAC + user-service
	if a.region == "ap-southeast-1" && svc == "user-service" {
		return scenarioRedisTimeoutAPAC
	}
	// S8: Globex batch import — tenant + products + POST
	if a.tenant == "tenant-globex" && a.route == "/api/products" && a.method == "POST" {
		return scenarioGlobexBatch
	}
	// S7: Umbrella compliance overhead — tenant + EU
	if a.tenant == "tenant-umbrella" && a.region == "eu-west-1" {
		return scenarioUmbrellaCompliance
	}

	return scenarioNormal
}

// ── Status code helpers ─────────────────────────────────────────────

func pickNormalStatusCode() int {
	r := rand.Float64()
	switch {
	case r < 0.95:
		return 200
	case r < 0.98:
		return 201
	default:
		return 404
	}
}

// ── Trace emission ──────────────────────────────────────────────────

func emitTrace(ctx context.Context, st *serviceTracers, ts time.Time, burnCfg burnProfileConfig, logEmit func(traceAttrs, string, int)) {
	a := traceAttrs{
		route:       pickWeighted(routes),
		method:      pickWeighted(methods),
		region:      pickWeighted(regions),
		buildID:     pickWeighted(buildIDs),
		platform:    pickWeighted(platforms),
		featureFlag: pickWeighted(featureFlags),
		tenant:      pickUniform(tenants),
		uid:         userID(),
		pod:         pickUniform(podNames),
	}

	sc := detectScenario(a)
	svc := routeToService(a.route)

	// Attributes placed on every span so comparison view works. Built from
	// commonKV (logs.go) so span attrs and log-record attrs stay in lockstep.
	commonAttrs := make([]attribute.KeyValue, 0, 9)
	for _, kv := range commonKV(a) {
		commonAttrs = append(commonAttrs, attribute.String(kv.Key, kv.Val))
	}

	// Dispatch to the scenario/burn emitter FIRST so we know the request's
	// REAL HTTP status, then emit exactly one log record carrying it (V1 fix:
	// previously the log was emitted here as a fixed SeverityInfo line before
	// the status was decided, making the logs pillar status-blind). Every
	// request — including deterministic burn events (504/503) — still
	// produces one log record (INV-1), it's just emitted after dispatch.
	var statusCode int
	if bStatus, level, ok := deterministicBurnDecision(a.route, burnCfg, rand.Float64()); ok {
		statusCode = bStatus
		emitDeterministicBurnTrace(ctx, st, ts, a, commonAttrs, svc, statusCode, level)
	} else {
		switch sc {
		case scenarioSlowCheckout:
			statusCode = emitSlowCheckout(ctx, st, ts, a, commonAttrs)
		case scenarioIOSOrderErrors:
			statusCode = emitIOSOrderErrors(ctx, st, ts, a, commonAttrs)
		case scenarioRedisTimeoutAPAC:
			statusCode = emitRedisTimeoutAPAC(ctx, st, ts, a, commonAttrs, svc)
		case scenarioInitechSearch:
			statusCode = emitInitechSearch(ctx, st, ts, a, commonAttrs)
		case scenarioAuthMemoryLeak:
			statusCode = emitAuthMemoryLeak(ctx, st, ts, a, commonAttrs)
		case scenarioPaymentTimeout:
			statusCode = emitPaymentTimeout(ctx, st, ts, a, commonAttrs)
		case scenarioUmbrellaCompliance:
			statusCode = emitUmbrellaCompliance(ctx, st, ts, a, commonAttrs, svc)
		case scenarioGlobexBatch:
			statusCode = emitGlobexBatch(ctx, st, ts, a, commonAttrs)
		default:
			statusCode = emitNormalTrace(ctx, st, ts, a, commonAttrs, svc)
		}
	}

	logEmit(a, fmt.Sprintf("%s %s -> %s", a.method, a.route, svc), statusCode)
}

func emitDeterministicBurnTrace(
	ctx context.Context,
	st *serviceTracers,
	ts time.Time,
	a traceAttrs,
	common []attribute.KeyValue,
	svc string,
	statusCode int,
	level burnLevel,
) {
	rootDur := gaussianDuration(120, 35)
	svcDur := gaussianDuration(80, 25)
	if level == burnLevelSteep {
		rootDur = gaussianDuration(900, 180)
		svcDur = gaussianDuration(700, 150)
	}

	rootCtx, rootSpan := st.tracer("api-gateway").Start(ctx, a.method+" "+a.route,
		trace.WithTimestamp(ts),
		trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(append(common,
			semconv.ServiceName("api-gateway"),
			attribute.Int("http.status_code", statusCode),
			attribute.String("app.burn_level", string(level)),
		)...),
	)
	markSpanError(rootSpan, "BurnProfileError", "deterministic burn profile")

	svcStart := ts.Add(jitter())
	svcCtx, svcSpan := st.tracer(svc).Start(rootCtx, svc+".handle",
		trace.WithTimestamp(svcStart),
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(append(svcAttrs(svc, a), attribute.String("app.burn_level", string(level)))...),
	)
	markSpanError(svcSpan, "BurnProfileError", "deterministic burn profile")

	dbSys := serviceToDBSystem(svc)
	emitNormalLeafSpan(st, svcCtx, svc, dbSys, a, svcStart.Add(jitter()))

	svcSpan.End(trace.WithTimestamp(svcStart.Add(svcDur)))
	rootSpan.End(trace.WithTimestamp(ts.Add(rootDur)))
}

// ── S1: Slow Checkout — feature flag + EU, N+1 queries ──────────────

func emitSlowCheckout(ctx context.Context, st *serviceTracers, ts time.Time, a traceAttrs, common []attribute.KeyValue) int {
	rootDur := gaussianDuration(1500, 400)
	svcDur := gaussianDuration(1200, 350)
	payDur := gaussianDuration(200, 50)

	rootCtx, rootSpan := st.tracer("api-gateway").Start(ctx, a.method+" "+a.route,
		trace.WithTimestamp(ts),
		trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(append(common,
			semconv.ServiceName("api-gateway"),
			attribute.Int("http.status_code", 200),
		)...),
	)
	rootSpan.SetStatus(codes.Ok, "")

	svcStart := ts.Add(jitter())
	svcCtx, svcSpan := st.tracer("order-service").Start(rootCtx, "order-service.handle",
		trace.WithTimestamp(svcStart),
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(svcAttrs("order-service", a)...),
	)

	// N+1 query pattern: 3-5 short postgres queries
	cursor := svcStart.Add(jitter())
	nQueries := 3 + rand.Intn(3)
	for i := 0; i < nQueries; i++ {
		qDur := gaussianDuration(float64(svcDur.Milliseconds())/float64(nQueries)*0.6, 20)
		_, dbSpan := st.tracer("order-service").Start(svcCtx, "postgres.query",
			trace.WithTimestamp(cursor),
			trace.WithSpanKind(trace.SpanKindClient),
			trace.WithAttributes(
				attribute.String("db.system", "postgres"),
				attribute.String("db.statement", fmt.Sprintf("SELECT * FROM orders WHERE id = %d", rand.Intn(10000))),
				semconv.ServiceName("order-service"),
				attribute.String("host.region", a.region),
			),
		)
		dbSpan.End(trace.WithTimestamp(cursor.Add(qDur)))
		cursor = cursor.Add(qDur).Add(time.Millisecond)
	}

	// Payment service call (succeeds but slow)
	payStart := cursor.Add(jitter())
	payCtx, paySpan := st.tracer("payment-service").Start(svcCtx, "payment-service.charge",
		trace.WithTimestamp(payStart),
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			semconv.ServiceName("payment-service"),
			attribute.String("host.region", a.region),
		),
	)
	extDur := gaussianDuration(150, 30)
	_, extSpan := st.tracer("payment-service").Start(payCtx, "external.payment.process",
		trace.WithTimestamp(payStart.Add(jitter())),
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			semconv.ServiceName("payment-service"),
			attribute.String("host.region", a.region),
		),
	)
	extSpan.End(trace.WithTimestamp(payStart.Add(extDur)))
	paySpan.End(trace.WithTimestamp(payStart.Add(payDur)))

	svcSpan.End(trace.WithTimestamp(svcStart.Add(svcDur)))
	rootSpan.End(trace.WithTimestamp(ts.Add(rootDur)))
	return 200
}

// ── S2: iOS Order Errors — bad build parse regression ───────────────

func emitIOSOrderErrors(ctx context.Context, st *serviceTracers, ts time.Time, a traceAttrs, common []attribute.KeyValue) int {
	rootDur := gaussianDuration(250, 60)
	svcDur := gaussianDuration(100, 30)

	rootCtx, rootSpan := st.tracer("api-gateway").Start(ctx, a.method+" "+a.route,
		trace.WithTimestamp(ts),
		trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(append(common,
			semconv.ServiceName("api-gateway"),
			attribute.Int("http.status_code", 500),
		)...),
	)
	markSpanError(rootSpan, "ValidationError", "malformed request body")

	svcStart := ts.Add(jitter())
	_, svcSpan := st.tracer("order-service").Start(rootCtx, "order-service.handle",
		trace.WithTimestamp(svcStart),
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(svcAttrs("order-service", a)...),
	)
	markSpanError(svcSpan, "ValidationError", "malformed request body")
	svcSpan.End(trace.WithTimestamp(svcStart.Add(svcDur)))
	rootSpan.End(trace.WithTimestamp(ts.Add(rootDur)))
	return 500
}

// ── S3: Redis Timeout APAC ──────────────────────────────────────────

func emitRedisTimeoutAPAC(ctx context.Context, st *serviceTracers, ts time.Time, a traceAttrs, common []attribute.KeyValue, svc string) int {
	rootDur := gaussianDuration(650, 120)
	svcDur := gaussianDuration(580, 100)

	rootCtx, rootSpan := st.tracer("api-gateway").Start(ctx, a.method+" "+a.route,
		trace.WithTimestamp(ts),
		trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(append(common,
			semconv.ServiceName("api-gateway"),
			attribute.Int("http.status_code", 200),
		)...),
	)
	rootSpan.SetStatus(codes.Ok, "")

	svcStart := ts.Add(jitter())
	svcCtx, svcSpan := st.tracer(svc).Start(rootCtx, svc+".handle",
		trace.WithTimestamp(svcStart),
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(svcAttrs(svc, a)...),
	)

	// Slow redis
	leafStart := svcStart.Add(jitter())
	redisDur := gaussianDuration(550, 100)
	_, redisSpan := st.tracer(svc).Start(svcCtx, "redis.get",
		trace.WithTimestamp(leafStart),
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("db.system", "redis"),
			attribute.String("db.statement", "GET user:session:"+a.uid),
			semconv.ServiceName(svc),
			attribute.String("host.region", a.region),
		),
	)
	redisSpan.End(trace.WithTimestamp(leafStart.Add(redisDur)))

	// Fallback postgres
	pgStart := leafStart.Add(redisDur).Add(time.Millisecond)
	pgDur := gaussianDuration(30, 10)
	_, pgSpan := st.tracer(svc).Start(svcCtx, "postgres.query",
		trace.WithTimestamp(pgStart),
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("db.system", "postgres"),
			attribute.String("db.statement", "SELECT * FROM users WHERE id = '"+a.uid+"'"),
			semconv.ServiceName(svc),
			attribute.String("host.region", a.region),
		),
	)
	pgSpan.End(trace.WithTimestamp(pgStart.Add(pgDur)))

	svcSpan.End(trace.WithTimestamp(svcStart.Add(svcDur)))
	rootSpan.End(trace.WithTimestamp(ts.Add(rootDur)))
	return 200
}

// ── S4: Initech Search Failure — tenant + dark-launch flag ──────────

func emitInitechSearch(ctx context.Context, st *serviceTracers, ts time.Time, a traceAttrs, common []attribute.KeyValue) int {
	rootDur := gaussianDuration(3000, 500)
	svcDur := gaussianDuration(2800, 450)

	rootCtx, rootSpan := st.tracer("api-gateway").Start(ctx, a.method+" "+a.route,
		trace.WithTimestamp(ts),
		trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(append(common,
			semconv.ServiceName("api-gateway"),
			attribute.Int("http.status_code", 500),
		)...),
	)
	markSpanError(rootSpan, "TimeoutError", "upstream timeout")

	svcStart := ts.Add(jitter())
	svcCtx, svcSpan := st.tracer("search-service").Start(rootCtx, "search-service.handle",
		trace.WithTimestamp(svcStart),
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(svcAttrs("search-service", a)...),
	)
	markSpanError(svcSpan, "TimeoutError", "elasticsearch timeout")

	// Elasticsearch timeout
	esStart := svcStart.Add(jitter())
	esDur := gaussianDuration(2500, 400)
	_, esSpan := st.tracer("search-service").Start(svcCtx, "elasticsearch.search",
		trace.WithTimestamp(esStart),
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("db.system", "elasticsearch"),
			attribute.String("db.statement", `{"query":{"match":{"tenant":"initech"}},"timeout":"2s"}`),
			semconv.ServiceName("search-service"),
			attribute.String("host.region", a.region),
		),
	)
	markSpanError(esSpan, "IOException", "read tcp: i/o timeout")
	esSpan.End(trace.WithTimestamp(esStart.Add(esDur)))

	svcSpan.End(trace.WithTimestamp(svcStart.Add(svcDur)))
	rootSpan.End(trace.WithTimestamp(ts.Add(rootDur)))
	return 500
}

// ── S5: Auth Memory Leak — build + pod, GC backpressure ─────────────

func emitAuthMemoryLeak(ctx context.Context, st *serviceTracers, ts time.Time, a traceAttrs, common []attribute.KeyValue) int {
	rootDur := gaussianDuration(800, 200)
	svcDur := gaussianDuration(700, 180)

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

	rootCtx, rootSpan := st.tracer("api-gateway").Start(ctx, a.method+" "+a.route,
		trace.WithTimestamp(ts),
		trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(append(common,
			semconv.ServiceName("api-gateway"),
			attribute.Int("http.status_code", statusCode),
		)...),
	)
	if errMsg != "" {
		markSpanError(rootSpan, "ServiceUnavailableError", errMsg)
	} else {
		rootSpan.SetStatus(codes.Ok, "")
	}

	svcStart := ts.Add(jitter())
	svcCtx, svcSpan := st.tracer("user-service").Start(rootCtx, "user-service.handle",
		trace.WithTimestamp(svcStart),
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(svcAttrs("user-service", a)...),
	)
	if errMsg != "" {
		markSpanError(svcSpan, "ServiceUnavailableError", errMsg)
	}

	// Slow redis from GC backpressure
	redisStart := svcStart.Add(jitter())
	redisDur := gaussianDuration(600, 150)
	_, redisSpan := st.tracer("user-service").Start(svcCtx, "redis.get",
		trace.WithTimestamp(redisStart),
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("db.system", "redis"),
			attribute.String("db.statement", "GET auth:token:"+a.uid),
			semconv.ServiceName("user-service"),
			attribute.String("host.region", a.region),
		),
	)
	redisSpan.End(trace.WithTimestamp(redisStart.Add(redisDur)))

	svcSpan.End(trace.WithTimestamp(svcStart.Add(svcDur)))
	rootSpan.End(trace.WithTimestamp(ts.Add(rootDur)))
	return statusCode
}

// ── S6: Payment Provider Timeout — us-west-2 external API ───────────

func emitPaymentTimeout(ctx context.Context, st *serviceTracers, ts time.Time, a traceAttrs, common []attribute.KeyValue) int {
	rootDur := gaussianDuration(5000, 500)
	svcDur := gaussianDuration(4800, 450)

	rootCtx, rootSpan := st.tracer("api-gateway").Start(ctx, a.method+" "+a.route,
		trace.WithTimestamp(ts),
		trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(append(common,
			semconv.ServiceName("api-gateway"),
			attribute.Int("http.status_code", 504),
		)...),
	)
	markSpanError(rootSpan, "TimeoutError", "gateway timeout")

	svcStart := ts.Add(jitter())
	svcCtx, svcSpan := st.tracer("order-service").Start(rootCtx, "order-service.handle",
		trace.WithTimestamp(svcStart),
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(svcAttrs("order-service", a)...),
	)
	markSpanError(svcSpan, "TimeoutError", "payment service timeout")

	// Quick DB write succeeds
	dbStart := svcStart.Add(jitter())
	dbDur := gaussianDuration(20, 8)
	_, dbSpan := st.tracer("order-service").Start(svcCtx, "postgres.query",
		trace.WithTimestamp(dbStart),
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("db.system", "postgres"),
			attribute.String("db.statement", "INSERT INTO orders (id, status) VALUES (...)"),
			semconv.ServiceName("order-service"),
			attribute.String("host.region", a.region),
		),
	)
	dbSpan.End(trace.WithTimestamp(dbStart.Add(dbDur)))

	// Payment service hangs
	payStart := dbStart.Add(dbDur).Add(jitter())
	payDur := gaussianDuration(4500, 300)
	payCtx, paySpan := st.tracer("payment-service").Start(svcCtx, "payment-service.charge",
		trace.WithTimestamp(payStart),
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			semconv.ServiceName("payment-service"),
			attribute.String("host.region", a.region),
		),
	)
	markSpanError(paySpan, "TimeoutError", "context deadline exceeded")

	_, extSpan := st.tracer("payment-service").Start(payCtx, "external.payment.process",
		trace.WithTimestamp(payStart.Add(jitter())),
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			semconv.ServiceName("payment-service"),
			attribute.String("host.region", a.region),
		),
	)
	markSpanError(extSpan, "IOException", "read tcp: i/o timeout")
	extSpan.End(trace.WithTimestamp(payStart.Add(payDur)))
	paySpan.End(trace.WithTimestamp(payStart.Add(payDur)))

	svcSpan.End(trace.WithTimestamp(svcStart.Add(svcDur)))
	rootSpan.End(trace.WithTimestamp(ts.Add(rootDur)))
	return 504
}

// ── S7: Umbrella EU Compliance — extra middleware latency ────────────

func emitUmbrellaCompliance(ctx context.Context, st *serviceTracers, ts time.Time, a traceAttrs, common []attribute.KeyValue, svc string) int {
	overhead := gaussianDuration(150, 40)
	baseDur := gaussianDuration(40, 20)
	rootDur := baseDur + overhead

	statusCode := pickNormalStatusCode()

	rootCtx, rootSpan := st.tracer("api-gateway").Start(ctx, a.method+" "+a.route,
		trace.WithTimestamp(ts),
		trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(append(common,
			semconv.ServiceName("api-gateway"),
			attribute.Int("http.status_code", statusCode),
		)...),
	)
	rootSpan.SetStatus(codes.Ok, "")

	svcStart := ts.Add(jitter())
	svcCtx, svcSpan := st.tracer(svc).Start(rootCtx, svc+".handle",
		trace.WithTimestamp(svcStart),
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(svcAttrs(svc, a)...),
	)

	// Compliance middleware check (the extra latency)
	compStart := svcStart.Add(jitter())
	_, compSpan := st.tracer(svc).Start(svcCtx, "compliance.data_residency_check",
		trace.WithTimestamp(compStart),
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(
			semconv.ServiceName(svc),
			attribute.String("app.tenant_id", a.tenant),
			attribute.String("host.region", a.region),
		),
	)
	compSpan.End(trace.WithTimestamp(compStart.Add(overhead)))

	// Normal DB call after compliance check
	dbSys := serviceToDBSystem(svc)
	emitNormalLeafSpan(st, svcCtx, svc, dbSys, a, compStart.Add(overhead).Add(jitter()))

	svcSpan.End(trace.WithTimestamp(svcStart.Add(baseDur + overhead)))
	rootSpan.End(trace.WithTimestamp(ts.Add(rootDur)))
	return statusCode
}

// ── S8: Globex Batch Import — saturated Elasticsearch ───────────────

func emitGlobexBatch(ctx context.Context, st *serviceTracers, ts time.Time, a traceAttrs, common []attribute.KeyValue) int {
	rootDur := gaussianDuration(600, 120)
	svcDur := gaussianDuration(500, 100)

	rootCtx, rootSpan := st.tracer("api-gateway").Start(ctx, a.method+" "+a.route,
		trace.WithTimestamp(ts),
		trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(append(common,
			semconv.ServiceName("api-gateway"),
			attribute.Int("http.status_code", 200),
		)...),
	)
	rootSpan.SetStatus(codes.Ok, "")

	svcStart := ts.Add(jitter())
	svcCtx, svcSpan := st.tracer("search-service").Start(rootCtx, "search-service.handle",
		trace.WithTimestamp(svcStart),
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(svcAttrs("search-service", a)...),
	)

	// Slow Elasticsearch write from batch contention
	esStart := svcStart.Add(jitter())
	esDur := gaussianDuration(450, 80)
	_, esSpan := st.tracer("search-service").Start(svcCtx, "elasticsearch.bulk_index",
		trace.WithTimestamp(esStart),
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("db.system", "elasticsearch"),
			attribute.String("db.statement", `{"index":{"_index":"products"}}`),
			semconv.ServiceName("search-service"),
			attribute.String("host.region", a.region),
		),
	)
	esSpan.End(trace.WithTimestamp(esStart.Add(esDur)))

	svcSpan.End(trace.WithTimestamp(svcStart.Add(svcDur)))
	rootSpan.End(trace.WithTimestamp(ts.Add(rootDur)))
	return 200
}

// ── Normal trace (healthy) ──────────────────────────────────────────

func emitNormalTrace(ctx context.Context, st *serviceTracers, ts time.Time, a traceAttrs, common []attribute.KeyValue, svc string) int {
	rootDur := gaussianDuration(40, 20)
	svcDur := gaussianDuration(25, 12)
	statusCode := pickNormalStatusCode()

	rootCtx, rootSpan := st.tracer("api-gateway").Start(ctx, a.method+" "+a.route,
		trace.WithTimestamp(ts),
		trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(append(common,
			semconv.ServiceName("api-gateway"),
			attribute.Int("http.status_code", statusCode),
		)...),
	)
	rootSpan.SetStatus(codes.Ok, "")

	svcStart := ts.Add(jitter())
	svcCtx, svcSpan := st.tracer(svc).Start(rootCtx, svc+".handle",
		trace.WithTimestamp(svcStart),
		trace.WithSpanKind(trace.SpanKindInternal),
		trace.WithAttributes(svcAttrs(svc, a)...),
	)

	// Standard DB/cache leaf
	dbSys := serviceToDBSystem(svc)
	leafStart := svcStart.Add(jitter())
	emitNormalLeafSpan(st, svcCtx, svc, dbSys, a, leafStart)

	// user-service also does a redis lookup (fast)
	if svc == "user-service" {
		rStart := leafStart.Add(gaussianDuration(10, 5)).Add(jitter())
		rDur := gaussianDuration(2, 1)
		_, rSpan := st.tracer(svc).Start(svcCtx, "redis.get",
			trace.WithTimestamp(rStart),
			trace.WithSpanKind(trace.SpanKindClient),
			trace.WithAttributes(
				attribute.String("db.system", "redis"),
				attribute.String("db.statement", "GET user:cache:"+a.uid),
				semconv.ServiceName(svc),
				attribute.String("host.region", a.region),
			),
		)
		rSpan.End(trace.WithTimestamp(rStart.Add(rDur)))
	}

	// Checkout: add payment-service call
	if a.route == "/cart/checkout" {
		payStart := svcStart.Add(gaussianDuration(15, 5))
		payDur := gaussianDuration(10, 4)
		payCtx, paySpan := st.tracer("payment-service").Start(svcCtx, "payment-service.charge",
			trace.WithTimestamp(payStart),
			trace.WithSpanKind(trace.SpanKindClient),
			trace.WithAttributes(
				semconv.ServiceName("payment-service"),
				attribute.String("host.region", a.region),
			),
		)
		extDur := gaussianDuration(8, 3)
		_, extSpan := st.tracer("payment-service").Start(payCtx, "external.payment.process",
			trace.WithTimestamp(payStart.Add(jitter())),
			trace.WithSpanKind(trace.SpanKindClient),
			trace.WithAttributes(
				semconv.ServiceName("payment-service"),
				attribute.String("host.region", a.region),
			),
		)
		extSpan.End(trace.WithTimestamp(payStart.Add(extDur)))
		paySpan.End(trace.WithTimestamp(payStart.Add(payDur)))
	}

	// Orders: add notification-service call
	if a.route == "/api/orders" && statusCode < 400 {
		notifStart := svcStart.Add(gaussianDuration(20, 5))
		notifDur := gaussianDuration(5, 2)
		_, notifSpan := st.tracer("notification-service").Start(svcCtx, "notification-service.send",
			trace.WithTimestamp(notifStart),
			trace.WithSpanKind(trace.SpanKindClient),
			trace.WithAttributes(
				semconv.ServiceName("notification-service"),
				attribute.String("host.region", a.region),
				attribute.String("user.id", a.uid),
			),
		)
		notifSpan.End(trace.WithTimestamp(notifStart.Add(notifDur)))
	}

	svcSpan.End(trace.WithTimestamp(svcStart.Add(svcDur)))
	rootSpan.End(trace.WithTimestamp(ts.Add(rootDur)))
	return statusCode
}

// ── Shared helpers for span construction ────────────────────────────

func jitter() time.Duration {
	return time.Duration(rand.Int63n(int64(2 * time.Millisecond)))
}

func svcAttrs(svc string, a traceAttrs) []attribute.KeyValue {
	return []attribute.KeyValue{
		semconv.ServiceName(svc),
		attribute.String("http.route", a.route),
		attribute.String("host.region", a.region),
		attribute.String("app.build_id", a.buildID),
		attribute.String("app.feature_flag", a.featureFlag),
		attribute.String("app.platform", a.platform),
		attribute.String("user.id", a.uid),
		attribute.String("app.tenant_id", a.tenant),
		attribute.String("k8s.pod.name", a.pod),
	}
}

func emitNormalLeafSpan(st *serviceTracers, parentCtx context.Context, svc, dbSys string, a traceAttrs, leafStart time.Time) {
	var leafName, leafDB, leafStmt string
	switch dbSys {
	case "postgres":
		leafName = "postgres.query"
		leafDB = "postgres"
		leafStmt = "SELECT * FROM " + strings.TrimPrefix(a.route, "/api/")
	case "elasticsearch":
		leafName = "elasticsearch.search"
		leafDB = "elasticsearch"
		leafStmt = `{"query":{"match_all":{}}}`
	default:
		return
	}

	leafDur := gaussianDuration(10, 5)
	_, leafSpan := st.tracer(svc).Start(parentCtx, leafName,
		trace.WithTimestamp(leafStart),
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("db.system", leafDB),
			attribute.String("db.statement", leafStmt),
			semconv.ServiceName(svc),
			attribute.String("host.region", a.region),
		),
	)
	leafSpan.End(trace.WithTimestamp(leafStart.Add(leafDur)))
}

// ── Main ────────────────────────────────────────────────────────────

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	endpoint := os.Getenv("OTEL_EXPORTER_OTLP_ENDPOINT")
	if endpoint == "" {
		endpoint = "localhost:4317"
	}

	conn, err := grpc.NewClient(endpoint,
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
	if err != nil {
		log.Fatalf("failed to create gRPC connection: %v", err)
	}
	defer conn.Close()

	exporter, err := otlptracegrpc.New(ctx, otlptracegrpc.WithGRPCConn(conn))
	if err != nil {
		log.Fatalf("failed to create trace exporter: %v", err)
	}

	st := newServiceTracers(ctx, exporter)
	metricsShutdown, err := startMetricEmitters(ctx, conn)
	if err != nil {
		log.Fatalf("failed to start metric emitters: %v", err)
	}
	logEmit, logShutdown, err := startLogEmitter(ctx, conn)
	if err != nil {
		log.Fatalf("failed to start log emitter: %v", err)
	}
	burnCfg := loadBurnProfileConfigFromEnv()
	log.Printf(
		"burn profile mode=%s steep=%s@%.4f slow=%s@%.4f",
		burnCfg.Mode,
		burnCfg.SteepRoute,
		burnCfg.SteepErrorRate,
		burnCfg.SlowRoute,
		burnCfg.SlowErrorRate,
	)
	defer func() {
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer shutdownCancel()
		st.shutdown(shutdownCtx)
		metricsShutdown(shutdownCtx)
		logShutdown(shutdownCtx)
	}()

	// Backfill 10 minutes of historical data
	log.Println("backfilling 10 minutes of historical data...")
	backfillStart := time.Now().Add(-10 * time.Minute)
	backfillTraces := 50 * 60 * 10 // 50/sec * 600 sec
	for i := 0; i < backfillTraces; i++ {
		ts := backfillStart.Add(time.Duration(rand.Int63n(int64(10 * time.Minute))))
		emitTrace(ctx, st, ts, burnCfg, logEmit)
	}
	log.Println("backfill complete, starting live emission...")

	// Live emission: ~50 traces/sec
	ticker := time.NewTicker(20 * time.Millisecond)
	defer ticker.Stop()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	for {
		select {
		case <-ticker.C:
			emitTrace(ctx, st, time.Now(), burnCfg, logEmit)
		case <-sigCh:
			log.Println("shutting down trace generator...")
			cancel()
			return
		}
	}
}
