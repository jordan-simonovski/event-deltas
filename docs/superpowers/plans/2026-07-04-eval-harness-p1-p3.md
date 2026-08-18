# Agent-RCA Eval Harness (P1–P3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the TypeScript eval harness that runs an agent RCA task against three tool surfaces (wide-SQL, bubble-up, three-pillars) over the live stack, judges correctness blindly, and reports tokens/time/tool-calls per arm × scenario.

**Architecture:** A new `eval/` npm-workspace package. Thin backend query executors (ClickHouse/Prometheus/Loki/Tempo) are exposed to a Claude agent as plain `Anthropic.Tool` schemas with a dispatch map. A **manual agentic loop** (Anthropic TypeScript SDK, `client.messages.create`) runs each cell, stopping the moment the agent calls the `submit_verdict` tool, and accumulating token usage across turns. A blind, different-model judge grades the verdict against a committed ground-truth RCA. A matrix runner sweeps scenario × arm × trial; a reporter aggregates to a table.

**Tech Stack:** TypeScript, Node 20+, `@anthropic-ai/sdk`, `tsx` + node:test, `@clickhouse/client`, native `fetch`. Reuses `@heatmap/shared-comparison` SQL builders for arm B.

## Global Constraints

- **Agent model (held constant across all arms):** `claude-sonnet-5`. **Judge model (different, blind):** `claude-opus-4-8`. Both from `eval/src/config.ts`, env-overridable, and recorded in the methodology doc. Do NOT pass `temperature`/`top_p`/`top_k` — rejected (400) on these models.
- **Fairness — identical across arms:** same system prompt, same per-scenario symptom prompt, same model, same trial count, same result-truncation cap. ONLY the tool set differs (INV-2).
- **Result truncation cap:** every query tool truncates its result payload to **8000 characters**, identical across arms; a truncated result is marked `…[truncated N chars]`.
- **Efficiency metrics are reported ONLY for judge-passing runs.** A cheap wrong answer is not a win.
- **Judge blindness:** the judge prompt must contain the symptom, ground-truth RCA, rubric, and the agent's `rca` text + claimed attributes — and MUST NOT contain the arm name or any token/time/tool-call figure.
- **S5** scored on `app.build_id` + `k8s.pod.name`. **S6** is the documented tie (region-only). Discriminating attributes come from the scenario table in `trace-generator/main.go`.
- **N trials default = 5**, `--concurrency` default = 4, subset via `--scenario`/`--arm`/`--trials`.
- **Backend URLs** default to `make up` host ports: ClickHouse `http://localhost:8123`, Prometheus `http://localhost:9090`, Loki `http://localhost:3100`, Tempo `http://localhost:3200`. Env-overridable.
- Eval is a **new workspace**; add `"eval"` to the root `package.json` `workspaces` array. Do not modify plugin or service code.
- Tests: `cd eval && npm test` runs `tsx --test test/*.test.ts`. Integration tests that need the live stack are gated behind `EVAL_LIVE=1` and skipped otherwise.

---

## File Structure

- `eval/package.json` (create) — workspace pkg, deps, `test` script.
- `eval/tsconfig.json` (create) — extends repo TS config style; NodeNext.
- `eval/src/config.ts` (create) — models, trials, concurrency, backend URLs, truncation cap; env overrides.
- `eval/src/backends/clickhouse.ts` (create) — `clickhouseSql(query): Promise<string>`.
- `eval/src/backends/prometheus.ts` (create) — `promql(query): Promise<string>`.
- `eval/src/backends/loki.ts` (create) — `logql(query): Promise<string>`.
- `eval/src/backends/tempo.ts` (create) — `traceql(query): Promise<string>`.
- `eval/src/backends/truncate.ts` (create) — shared `truncate(s, cap): string`.
- `eval/src/tools/submitVerdict.ts` (create) — verdict tool schema + `Verdict` type.
- `eval/src/tools/wideSqlTools.ts` (create) — arm A tool set.
- `eval/src/tools/pillarsTools.ts` (create) — arm C tool set.
- `eval/src/tools/bubbleUpTools.ts` (create) — arm B tool set (wraps `@heatmap/shared-comparison`).
- `eval/src/tools/types.ts` (create) — `ArmTools` interface.
- `eval/src/scenarios.ts` (create) — `Scenario[]` for S1–S8.
- `eval/src/runner.ts` (create) — `runCell(scenario, arm, deps): Promise<CellResult>`.
- `eval/src/judge.ts` (create) — `judge(scenario, verdict, deps): Promise<Judgement>` + `buildJudgePrompt`.
- `eval/src/matrix.ts` (create) — `runMatrix(opts): Promise<CellResult[]>`.
- `eval/src/report.ts` (create) — `aggregate(rows): ReportTable` + `renderTable`.
- `eval/src/index.ts` (create) — CLI entry: parse flags, run matrix, write report.
- `eval/test/*.test.ts` (create) — unit + gated integration tests.
- `docs/eval-methodology.md` (create, Task 9) — methodology writeup.
- `Makefile` (modify) — add `eval` target.
- root `package.json` (modify) — add `eval` workspace.

---

## Task 1: Package scaffold

**Files:**
- Create: `eval/package.json`, `eval/tsconfig.json`, `eval/src/config.ts`, `eval/test/config.test.ts`
- Modify: root `package.json` (workspaces)

**Interfaces:**
- Produces: `config` object — `{ agentModel: string, judgeModel: string, trials: number, concurrency: number, truncateCap: number, urls: { clickhouse, prometheus, loki, tempo }, maxTokensPerTurn: number }`, all env-overridable.

- [ ] **Step 1: Write eval/package.json**

```json
{
  "name": "@heatmap/eval",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "tsx --test test/*.test.ts",
    "typecheck": "tsc --noEmit",
    "eval": "tsx src/index.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.70.0",
    "@clickhouse/client": "^1.0.0",
    "@heatmap/shared-comparison": "*",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.5.0",
    "@types/node": "^20.0.0"
  }
}
```

- [ ] **Step 2: Write eval/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Add eval to root workspaces**

In root `package.json`, add `"eval"` to the `workspaces` array (currently `["packages/*", "plugins/heatmap-panel", "plugins/timeseries-selection-panel", "plugins/heatmap-app", "plugins/slo-app"]`). Result:

```json
  "workspaces": [
    "packages/*",
    "plugins/heatmap-panel",
    "plugins/timeseries-selection-panel",
    "plugins/heatmap-app",
    "plugins/slo-app",
    "eval"
  ],
```

- [ ] **Step 4: Write the failing test**

Create `eval/test/config.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { config } from "../src/config.ts";

test("config exposes both models and they differ", () => {
  assert.equal(config.agentModel, "claude-sonnet-5");
  assert.equal(config.judgeModel, "claude-opus-4-8");
  assert.notEqual(config.agentModel, config.judgeModel);
});

test("config defaults", () => {
  assert.equal(config.trials, 5);
  assert.equal(config.truncateCap, 8000);
  assert.equal(config.urls.clickhouse, "http://localhost:8123");
});
```

- [ ] **Step 5: Run test to verify it fails**

Run: `cd eval && npm install && npm test`
Expected: FAIL — cannot find `../src/config.ts`.

- [ ] **Step 6: Write eval/src/config.ts**

```typescript
const env = process.env;

export const config = {
  agentModel: env.EVAL_AGENT_MODEL ?? "claude-sonnet-5",
  judgeModel: env.EVAL_JUDGE_MODEL ?? "claude-opus-4-8",
  trials: Number(env.EVAL_TRIALS ?? 5),
  concurrency: Number(env.EVAL_CONCURRENCY ?? 4),
  truncateCap: Number(env.EVAL_TRUNCATE_CAP ?? 8000),
  maxTokensPerTurn: Number(env.EVAL_MAX_TOKENS ?? 16000),
  urls: {
    clickhouse: env.EVAL_CLICKHOUSE_URL ?? "http://localhost:8123",
    prometheus: env.EVAL_PROMETHEUS_URL ?? "http://localhost:9090",
    loki: env.EVAL_LOKI_URL ?? "http://localhost:3100",
    tempo: env.EVAL_TEMPO_URL ?? "http://localhost:3200",
  },
} as const;
```

- [ ] **Step 7: Run test to verify it passes**

Run: `cd eval && npm test`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add eval/package.json eval/tsconfig.json eval/src/config.ts eval/test/config.test.ts package.json package-lock.json
git commit -m "feat(eval): scaffold eval harness package + config

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Backend query executors

**Files:**
- Create: `eval/src/backends/truncate.ts`, `eval/src/backends/clickhouse.ts`, `eval/src/backends/prometheus.ts`, `eval/src/backends/loki.ts`, `eval/src/backends/tempo.ts`
- Create: `eval/test/truncate.test.ts`, `eval/test/backends.live.test.ts`

**Interfaces:**
- Consumes: `config.urls`, `config.truncateCap` (Task 1).
- Produces:
  - `truncate(s: string, cap: number): string`
  - `clickhouseSql(query: string): Promise<string>` — runs SQL over ClickHouse HTTP, returns rows as text.
  - `promql(query: string): Promise<string>`, `logql(query: string): Promise<string>`, `traceql(query: string): Promise<string>` — instant/range query against each backend, JSON stringified + truncated. Each returns the backend's real error text on failure (no auto-fixing — the agent pays the correction cost).

- [ ] **Step 1: Write the failing truncate test**

Create `eval/test/truncate.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { truncate } from "../src/backends/truncate.ts";

test("passes short strings through", () => {
  assert.equal(truncate("hello", 100), "hello");
});

test("truncates and annotates long strings", () => {
  const s = "x".repeat(50);
  const out = truncate(s, 10);
  assert.ok(out.startsWith("xxxxxxxxxx"));
  assert.ok(out.includes("[truncated 40 chars]"));
  assert.ok(out.length < s.length);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd eval && npm test`
Expected: FAIL — cannot find `../src/backends/truncate.ts`.

- [ ] **Step 3: Write truncate.ts**

```typescript
export function truncate(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return s.slice(0, cap) + `\n…[truncated ${s.length - cap} chars]`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd eval && npm test`
Expected: PASS.

- [ ] **Step 5: Write the four backend executors**

Create `eval/src/backends/clickhouse.ts`:

```typescript
import { config } from "../config.ts";
import { truncate } from "./truncate.ts";

// Runs agent-authored SQL over ClickHouse HTTP. Returns TabSeparatedWithNames
// text (or the real error), truncated. No query rewriting — the agent authors
// SQL by hand; that friction is what the benchmark measures.
export async function clickhouseSql(query: string): Promise<string> {
  const url = `${config.urls.clickhouse}/?default_format=TabSeparatedWithNames`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-ClickHouse-User": process.env.EVAL_CLICKHOUSE_USER ?? "default",
      "X-ClickHouse-Key": process.env.EVAL_CLICKHOUSE_PASSWORD ?? "",
    },
    body: query,
  });
  const text = await res.text();
  if (!res.ok) return `ClickHouse error (${res.status}): ${truncate(text, config.truncateCap)}`;
  return truncate(text, config.truncateCap);
}
```

Create `eval/src/backends/prometheus.ts`:

```typescript
import { config } from "../config.ts";
import { truncate } from "./truncate.ts";

// Instant PromQL query. The agent may pass range selectors in the query itself.
export async function promql(query: string): Promise<string> {
  const url = new URL(`${config.urls.prometheus}/api/v1/query`);
  url.searchParams.set("query", query);
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  if (!res.ok) return `Prometheus error (${res.status}): ${truncate(text, config.truncateCap)}`;
  return truncate(text, config.truncateCap);
}
```

Create `eval/src/backends/loki.ts`:

```typescript
import { config } from "../config.ts";
import { truncate } from "./truncate.ts";

// LogQL range query over the last 2 hours (matches the emitted data window).
export async function logql(query: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const url = new URL(`${config.urls.loki}/loki/api/v1/query_range`);
  url.searchParams.set("query", query);
  url.searchParams.set("limit", "50");
  url.searchParams.set("start", `${(now - 7200) * 1_000_000_000}`);
  url.searchParams.set("end", `${now * 1_000_000_000}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  if (!res.ok) return `Loki error (${res.status}): ${truncate(text, config.truncateCap)}`;
  return truncate(text, config.truncateCap);
}
```

Create `eval/src/backends/tempo.ts`:

```typescript
import { config } from "../config.ts";
import { truncate } from "./truncate.ts";

// TraceQL search over the last 2 hours.
export async function traceql(query: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const url = new URL(`${config.urls.tempo}/api/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit", "20");
  url.searchParams.set("start", `${now - 7200}`);
  url.searchParams.set("end", `${now}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  if (!res.ok) return `Tempo error (${res.status}): ${truncate(text, config.truncateCap)}`;
  return truncate(text, config.truncateCap);
}
```

- [ ] **Step 6: Write the gated integration smoke test**

Create `eval/test/backends.live.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { clickhouseSql } from "../src/backends/clickhouse.ts";
import { promql } from "../src/backends/prometheus.ts";
import { logql } from "../src/backends/loki.ts";
import { traceql } from "../src/backends/tempo.ts";

const live = process.env.EVAL_LIVE === "1";

test("clickhouse returns span rows", { skip: !live }, async () => {
  const out = await clickhouseSql("SELECT count() FROM otel_traces");
  assert.match(out, /\d/);
});

test("prometheus returns RED metric series", { skip: !live }, async () => {
  const out = await promql("traces_span_metrics_calls_total");
  assert.match(out, /"status":"success"/);
});

test("loki returns generator logs", { skip: !live }, async () => {
  const out = await logql('{service_name="trace-generator"}');
  assert.match(out, /"status":"success"/);
});

test("tempo returns traces", { skip: !live }, async () => {
  const out = await traceql('{ span.app.feature_flag="new-checkout-flow" }');
  assert.match(out, /traces|"traces"/);
});
```

- [ ] **Step 7: Run tests (unit pass; integration verified against live stack)**

Run unit only: `cd eval && npm test` → truncate tests PASS, live tests skipped.
Then with the stack up: `cd eval && EVAL_LIVE=1 npm test` → all 4 live tests PASS. Paste the output in the report.

- [ ] **Step 8: Commit**

```bash
git add eval/src/backends/ eval/test/truncate.test.ts eval/test/backends.live.test.ts
git commit -m "feat(eval): backend query executors for all four stores

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Scenario definitions

**Files:**
- Create: `eval/src/scenarios.ts`, `eval/test/scenarios.test.ts`

**Interfaces:**
- Produces:
  - `type Attr = { key: string; value: string }`
  - `type Scenario = { id: string; symptomPrompt: string; groundTruthRca: string; culpritService: string; discriminatingAttributes: Attr[]; rubric: string; tie?: boolean }`
  - `export const scenarios: Scenario[]` — S1–S8.

- [ ] **Step 1: Write the failing test**

Create `eval/test/scenarios.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { scenarios } from "../src/scenarios.ts";

test("all 8 scenarios present and well-formed", () => {
  assert.equal(scenarios.length, 8);
  for (const s of scenarios) {
    assert.ok(s.id, "id");
    assert.ok(s.symptomPrompt.length > 10, `${s.id} symptomPrompt`);
    assert.ok(s.groundTruthRca.length > 10, `${s.id} groundTruthRca`);
    assert.ok(s.culpritService, `${s.id} culpritService`);
    assert.ok(s.rubric.length > 10, `${s.id} rubric`);
    // Symptom prompt must not name the discriminating values (no giveaway).
    for (const a of s.discriminatingAttributes) {
      assert.ok(
        !s.symptomPrompt.toLowerCase().includes(a.value.toLowerCase()),
        `${s.id} symptom leaks ${a.value}`,
      );
    }
  }
});

test("S6 is the tie, others have discriminators", () => {
  const s6 = scenarios.find((s) => s.id === "S6")!;
  assert.equal(s6.tie, true);
  for (const s of scenarios.filter((s) => s.id !== "S6")) {
    assert.ok(s.discriminatingAttributes.length > 0, `${s.id} needs discriminators`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd eval && npm test`
Expected: FAIL — cannot find `../src/scenarios.ts`.

- [ ] **Step 3: Write scenarios.ts**

Values come from the scenario table in `trace-generator/main.go`. Symptom prompts state the symptom, never the cause.

```typescript
export type Attr = { key: string; value: string };

export type Scenario = {
  id: string;
  symptomPrompt: string;
  groundTruthRca: string;
  culpritService: string;
  discriminatingAttributes: Attr[];
  rubric: string;
  tie?: boolean;
};

const TASK = "Investigate using your tools and, when confident, call submit_verdict with the culprit service and the attribute key/values that distinguish the failing requests.";

export const scenarios: Scenario[] = [
  {
    id: "S1",
    symptomPrompt: `The SLO for checkout p99 latency has been burning over the last 15 minutes. ${TASK}`,
    groundTruthRca:
      "Checkout latency (p99 ~1500ms, N+1 DB queries) is isolated to requests with feature flag new-checkout-flow in region eu-west-1. The new-checkout-flow feature flag rollout in eu-west-1 is the root cause.",
    culpritService: "order-service",
    discriminatingAttributes: [
      { key: "app.feature_flag", value: "new-checkout-flow" },
      { key: "host.region", value: "eu-west-1" },
    ],
    rubric:
      "PASS if the answer identifies the new-checkout-flow feature flag (the high-cardinality discriminator) as the root cause, ideally scoped to eu-west-1. Region alone is insufficient; naming the feature flag is required.",
  },
  {
    id: "S2",
    symptomPrompt: `Error rate on the orders API has spiked. ${TASK}`,
    groundTruthRca:
      "HTTP 500s (~250ms) on /api/orders are isolated to platform=ios on build build-7a3. The build-7a3 release on iOS is the root cause.",
    culpritService: "order-service",
    discriminatingAttributes: [
      { key: "app.platform", value: "ios" },
      { key: "app.build_id", value: "build-7a3" },
    ],
    rubric:
      "PASS if the answer identifies build build-7a3 on the iOS platform as the root cause. Both platform and build_id should appear; identifying build-7a3 is required.",
  },
  {
    id: "S3",
    symptomPrompt: `User-service latency is elevated in one region. ${TASK}`,
    groundTruthRca:
      "p99 ~650ms on user-service in region ap-southeast-1 caused by Redis timeouts falling back to Postgres (db.system redis slow). The root cause is the Redis timeout in ap-southeast-1.",
    culpritService: "user-service",
    discriminatingAttributes: [
      { key: "host.region", value: "ap-southeast-1" },
      { key: "db.system", value: "redis" },
    ],
    rubric:
      "PASS if the answer identifies Redis (db.system=redis) timeouts in ap-southeast-1 as the cause. db.system is trace-only; naming Redis as the failing dependency is required.",
  },
  {
    id: "S4",
    symptomPrompt: `Search requests are failing for one tenant. ${TASK}`,
    groundTruthRca:
      "HTTP 500 (Elasticsearch timeout ~3s) on /api/search for tenant tenant-initech with feature flag dark-launch-search. The dark-launch-search flag for tenant-initech is the root cause.",
    culpritService: "search-service",
    discriminatingAttributes: [
      { key: "app.tenant_id", value: "tenant-initech" },
      { key: "app.feature_flag", value: "dark-launch-search" },
    ],
    rubric:
      "PASS if the answer identifies tenant-initech with the dark-launch-search feature flag as the root cause. Both are required.",
  },
  {
    id: "S5",
    symptomPrompt: `Auth requests show intermittent 503s and rising latency. ${TASK}`,
    groundTruthRca:
      "Intermittent 503s and p99 ~800ms on /api/auth from a memory leak on build build-7a3, concentrated on pods pod-abc-7 and pod-abc-8. The build-7a3 memory leak on those pods is the root cause.",
    culpritService: "user-service",
    discriminatingAttributes: [
      { key: "app.build_id", value: "build-7a3" },
      { key: "k8s.pod.name", value: "pod-abc-7" },
    ],
    rubric:
      "PASS if the answer identifies build build-7a3 AND the affected pods (pod-abc-7 / pod-abc-8) as the root cause. Score on build_id + pod; the memory-saturation mechanism is supporting evidence, not required.",
  },
  {
    id: "S6",
    symptomPrompt: `Checkout is timing out for some users. ${TASK}`,
    groundTruthRca:
      "HTTP 504 (~5s payment provider timeout) on /cart/checkout isolated to region us-west-2. The us-west-2 payment provider timeout is the root cause.",
    culpritService: "payment-service",
    discriminatingAttributes: [{ key: "host.region", value: "us-west-2" }],
    tie: true,
    rubric:
      "PASS if the answer identifies region us-west-2 as the root cause of the checkout 504s. (This scenario is region-only — an expected tie across arms.)",
  },
  {
    id: "S7",
    symptomPrompt: `One tenant reports across-the-board slowness. ${TASK}`,
    groundTruthRca:
      "A +150ms overhead on all routes for tenant tenant-umbrella in region eu-west-1 (EU compliance overhead). tenant-umbrella in eu-west-1 is the root cause.",
    culpritService: "api-gateway",
    discriminatingAttributes: [
      { key: "app.tenant_id", value: "tenant-umbrella" },
      { key: "host.region", value: "eu-west-1" },
    ],
    rubric:
      "PASS if the answer identifies tenant-umbrella (the high-cardinality discriminator), ideally scoped to eu-west-1, as the source of the latency overhead.",
  },
  {
    id: "S8",
    symptomPrompt: `Product API writes are slow for one tenant. ${TASK}`,
    groundTruthRca:
      "Slow Elasticsearch (~500ms) on POST /api/products for tenant tenant-globex (batch import). tenant-globex's product batch import is the root cause.",
    culpritService: "search-service",
    discriminatingAttributes: [
      { key: "app.tenant_id", value: "tenant-globex" },
      { key: "http.method", value: "POST" },
    ],
    rubric:
      "PASS if the answer identifies tenant-globex on POST /api/products as the root cause. Naming tenant-globex is required.",
  },
];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd eval && npm test`
Expected: PASS. (If the leak check trips, reword the symptom prompt — it must not contain a discriminating value.)

- [ ] **Step 5: Commit**

```bash
git add eval/src/scenarios.ts eval/test/scenarios.test.ts
git commit -m "feat(eval): S1-S8 scenarios with ground-truth RCAs and rubrics

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Tool surfaces (three arms + verdict)

**Files:**
- Create: `eval/src/tools/types.ts`, `eval/src/tools/submitVerdict.ts`, `eval/src/tools/wideSqlTools.ts`, `eval/src/tools/pillarsTools.ts`, `eval/src/tools/bubbleUpTools.ts`
- Create: `eval/test/tools.test.ts`

**Interfaces:**
- Consumes: backend executors (Task 2); `@heatmap/shared-comparison` (`buildFilterClause`, `escapeSql` from `sqlFilters.ts` — both pure, no Grafana deps).
- Produces:
  - `type Handler = (input: any) => Promise<string>`
  - `type ArmTools = { name: "wide-sql" | "bubble-up" | "pillars"; definitions: Anthropic.Tool[]; handlers: Record<string, Handler> }`
  - `SUBMIT_VERDICT: Anthropic.Tool` and `type Verdict = { rca: string; culprit_service: string; discriminating_attributes: {key: string; value: string}[] }`
  - `wideSqlArm`, `pillarsArm`, `bubbleUpArm` — each an `ArmTools` (without submit_verdict; the runner appends it).

- [ ] **Step 1: Write submitVerdict.ts**

```typescript
import type Anthropic from "@anthropic-ai/sdk";

export type Verdict = {
  rca: string;
  culprit_service: string;
  discriminating_attributes: { key: string; value: string }[];
};

export const SUBMIT_VERDICT: Anthropic.Tool = {
  name: "submit_verdict",
  description:
    "Submit your final root-cause conclusion and end the investigation. Call this exactly once when you are confident.",
  input_schema: {
    type: "object",
    properties: {
      rca: { type: "string", description: "Concise root-cause explanation." },
      culprit_service: { type: "string", description: "The service at fault." },
      discriminating_attributes: {
        type: "array",
        description: "The attribute key/values that distinguish the failing requests.",
        items: {
          type: "object",
          properties: { key: { type: "string" }, value: { type: "string" } },
          required: ["key", "value"],
        },
      },
    },
    required: ["rca", "culprit_service", "discriminating_attributes"],
  },
};
```

- [ ] **Step 2: Write types.ts**

```typescript
import type Anthropic from "@anthropic-ai/sdk";

export type Handler = (input: any) => Promise<string>;

export type ArmTools = {
  name: "wide-sql" | "bubble-up" | "pillars";
  definitions: Anthropic.Tool[];
  handlers: Record<string, Handler>;
};
```

- [ ] **Step 3: Write wideSqlTools.ts (arm A)**

```typescript
import type Anthropic from "@anthropic-ai/sdk";
import { clickhouseSql } from "../backends/clickhouse.ts";
import type { ArmTools } from "./types.ts";

const clickhouseTool: Anthropic.Tool = {
  name: "clickhouse_sql",
  description:
    "Run a ClickHouse SQL query over the otel_traces table (one wide row per span, all attributes in SpanAttributes/ResourceAttributes maps). Returns TabSeparatedWithNames.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "ClickHouse SQL." } },
    required: ["query"],
  },
};

export const wideSqlArm: ArmTools = {
  name: "wide-sql",
  definitions: [clickhouseTool],
  handlers: { clickhouse_sql: (i) => clickhouseSql(i.query) },
};
```

- [ ] **Step 4: Write pillarsTools.ts (arm C)**

```typescript
import type Anthropic from "@anthropic-ai/sdk";
import { promql } from "../backends/prometheus.ts";
import { logql } from "../backends/loki.ts";
import { traceql } from "../backends/tempo.ts";
import type { ArmTools } from "./types.ts";

const promTool: Anthropic.Tool = {
  name: "promql",
  description: "Run an instant PromQL query against Prometheus (RED metrics: traces_span_metrics_*). Metrics carry only low-cardinality labels (service, http_route, host_region, status_code).",
  input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};
const lokiTool: Anthropic.Tool = {
  name: "loki_logql",
  description: "Run a LogQL query against Loki over the last 2h. Per-request attributes are structured metadata (e.g. `{service_name=\"trace-generator\"} | app_feature_flag=\\`value\\``).",
  input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};
const tempoTool: Anthropic.Tool = {
  name: "traceql",
  description: "Run a TraceQL search against Tempo over the last 2h (e.g. `{ span.app.feature_flag=\"value\" }`).",
  input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};

export const pillarsArm: ArmTools = {
  name: "pillars",
  definitions: [promTool, lokiTool, tempoTool],
  handlers: {
    promql: (i) => promql(i.query),
    loki_logql: (i) => logql(i.query),
    traceql: (i) => traceql(i.query),
  },
};
```

- [ ] **Step 5: Write bubbleUpTools.ts (arm B)**

Arm B = arm A's SQL tool + bubble-up primitives that build selection/baseline comparison SQL via `@heatmap/shared-comparison` and execute it. Import the pure builders from `sqlFilters.ts`.

```typescript
import type Anthropic from "@anthropic-ai/sdk";
import { clickhouseSql } from "../backends/clickhouse.ts";
import { buildFilterClause } from "@heatmap/shared-comparison/src/sqlFilters";
import type { ArmTools } from "./types.ts";

const clickhouseTool: Anthropic.Tool = {
  name: "clickhouse_sql",
  description:
    "Run a ClickHouse SQL query over otel_traces. Returns TabSeparatedWithNames.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
};

// rank_attributes: for a selection predicate, rank which attribute values are
// over-represented in the selection vs its NOT(selection) baseline — the
// bubble-up grammar from packages/shared-comparison, executed as SQL.
const rankTool: Anthropic.Tool = {
  name: "rank_attributes",
  description:
    "Given a WHERE predicate identifying a selected region of spans, rank which SpanAttributes keys/values are most over-represented in the selection vs the baseline (NOT the predicate). Use this to find what distinguishes the failing requests.",
  input_schema: {
    type: "object",
    properties: {
      selection_predicate: {
        type: "string",
        description: "A ClickHouse boolean expression over otel_traces columns, e.g. \"StatusCode='STATUS_CODE_ERROR'\".",
      },
      attribute_keys: {
        type: "array",
        items: { type: "string" },
        description: "SpanAttributes keys to compare, e.g. [\"app.feature_flag\",\"host.region\"].",
      },
    },
    required: ["selection_predicate", "attribute_keys"],
  },
};

async function rankAttributes(input: {
  selection_predicate: string;
  attribute_keys: string[];
}): Promise<string> {
  // For each key, compare selection share vs baseline share (percentage-point
  // diff, selection-first) — mirrors computeComparison in shared-comparison.
  const pred = input.selection_predicate;
  const parts = input.attribute_keys.map((key) => {
    const col = `SpanAttributes['${key.replace(/'/g, "\\'")}']`;
    return `
SELECT '${key}' AS attr, ${col} AS value,
  countIf(${pred}) AS sel,
  countIf(NOT (${pred})) AS base,
  round(100 * countIf(${pred}) / nullIf(sum(countIf(${pred})) OVER (), 0), 1) AS sel_pct
FROM otel_traces
WHERE ${col} != ''
GROUP BY value
HAVING sel > 0
ORDER BY sel_pct DESC
LIMIT 5`;
  });
  const sql = parts.join("\nUNION ALL\n");
  return clickhouseSql(sql);
}

export const bubbleUpArm: ArmTools = {
  name: "bubble-up",
  definitions: [clickhouseTool, rankTool],
  handlers: {
    clickhouse_sql: (i) => clickhouseSql(i.query),
    rank_attributes: (i) => rankAttributes(i),
  },
};
```

(`buildFilterClause` is imported to confirm the dependency resolves and is available for richer predicate construction; the minimal `rank_attributes` above builds SQL directly. If the import path `@heatmap/shared-comparison/src/sqlFilters` fails to resolve under NodeNext, import from the package root `@heatmap/shared-comparison` and reference the re-export in `index.ts`, or add a `"exports"` map — resolve at build time; the typecheck in Step 7 is the gate.)

- [ ] **Step 6: Write the tools test**

Create `eval/test/tools.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { wideSqlArm } from "../src/tools/wideSqlTools.ts";
import { pillarsArm } from "../src/tools/pillarsTools.ts";
import { bubbleUpArm } from "../src/tools/bubbleUpTools.ts";
import { SUBMIT_VERDICT } from "../src/tools/submitVerdict.ts";

test("each arm exposes definitions with matching handlers", () => {
  for (const arm of [wideSqlArm, pillarsArm, bubbleUpArm]) {
    assert.ok(arm.definitions.length > 0, `${arm.name} has tools`);
    for (const def of arm.definitions) {
      assert.equal(typeof arm.handlers[def.name], "function", `${arm.name}:${def.name} handler`);
    }
  }
});

test("arms differ only in tools, pillars has no SQL", () => {
  const pillarNames = pillarsArm.definitions.map((d) => d.name);
  assert.deepEqual(pillarNames.sort(), ["loki_logql", "promql", "traceql"]);
  assert.ok(!pillarNames.includes("clickhouse_sql"));
});

test("submit_verdict requires the three verdict fields", () => {
  assert.deepEqual(
    (SUBMIT_VERDICT.input_schema.required as string[]).sort(),
    ["culprit_service", "discriminating_attributes", "rca"],
  );
});
```

- [ ] **Step 7: Run test + typecheck**

Run: `cd eval && npm test && npm run typecheck`
Expected: tests PASS; typecheck clean (resolves the `@heatmap/shared-comparison` import).

- [ ] **Step 8: Commit**

```bash
git add eval/src/tools/ eval/test/tools.test.ts
git commit -m "feat(eval): three arm tool surfaces + submit_verdict terminal tool

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Single-cell agent runner (P2 milestone core)

**Files:**
- Create: `eval/src/runner.ts`, `eval/test/runner.test.ts`, `eval/test/runner.live.test.ts`

**Interfaces:**
- Consumes: `config`, `ArmTools`, `SUBMIT_VERDICT`, `Verdict`, `Scenario`.
- Produces:
  - `type Usage = { inputTokens: number; outputTokens: number }`
  - `type CellResult = { scenario: string; arm: string; trial: number; verdict: Verdict | null; usage: Usage; wallClockMs: number; toolCalls: number; turns: number }`
  - `accumulateUsage(prev: Usage, u: {input_tokens: number; output_tokens: number}): Usage` — pure helper.
  - `runCell(scenario: Scenario, arm: ArmTools, trial: number, client: Anthropic, nowMs: () => number): Promise<CellResult>` — manual agentic loop; stops when the agent calls `submit_verdict`; captures usage/time/tool-calls/turns.

- [ ] **Step 1: Write the failing unit test (usage accumulation)**

Create `eval/test/runner.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { accumulateUsage } from "../src/runner.ts";

test("accumulates token usage across turns", () => {
  let u = { inputTokens: 0, outputTokens: 0 };
  u = accumulateUsage(u, { input_tokens: 100, output_tokens: 20 });
  u = accumulateUsage(u, { input_tokens: 150, output_tokens: 30 });
  assert.deepEqual(u, { inputTokens: 250, outputTokens: 50 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd eval && npm test`
Expected: FAIL — cannot find `accumulateUsage`.

- [ ] **Step 3: Write runner.ts**

```typescript
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.ts";
import type { ArmTools } from "./tools/types.ts";
import { SUBMIT_VERDICT, type Verdict } from "./tools/submitVerdict.ts";
import type { Scenario } from "./scenarios.ts";

export type Usage = { inputTokens: number; outputTokens: number };
export type CellResult = {
  scenario: string;
  arm: string;
  trial: number;
  verdict: Verdict | null;
  usage: Usage;
  wallClockMs: number;
  toolCalls: number;
  turns: number;
};

export function accumulateUsage(prev: Usage, u: { input_tokens: number; output_tokens: number }): Usage {
  return {
    inputTokens: prev.inputTokens + u.input_tokens,
    outputTokens: prev.outputTokens + u.output_tokens,
  };
}

const SYSTEM_PROMPT =
  "You are a senior SRE performing root-cause analysis on a microservices incident. " +
  "Investigate methodically using ONLY the tools provided. When you are confident you have " +
  "identified the root cause, call submit_verdict exactly once with the culprit service and the " +
  "attribute key/values that distinguish the failing requests. Do not call submit_verdict until you have evidence.";

const MAX_TURNS = 25;

export async function runCell(
  scenario: Scenario,
  arm: ArmTools,
  trial: number,
  client: Anthropic,
  nowMs: () => number,
): Promise<CellResult> {
  const tools = [...arm.definitions, SUBMIT_VERDICT];
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: scenario.symptomPrompt },
  ];
  let usage: Usage = { inputTokens: 0, outputTokens: 0 };
  let toolCalls = 0;
  let turns = 0;
  let verdict: Verdict | null = null;
  const start = nowMs();

  while (turns < MAX_TURNS) {
    turns++;
    const res = await client.messages.create({
      model: config.agentModel,
      max_tokens: config.maxTokensPerTurn,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });
    usage = accumulateUsage(usage, res.usage);
    messages.push({ role: "assistant", content: res.content });

    const toolUses = res.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    if (toolUses.length === 0) break; // agent ended without a verdict

    const verdictCall = toolUses.find((t) => t.name === "submit_verdict");
    if (verdictCall) {
      verdict = verdictCall.input as Verdict;
      break; // terminal tool — stop immediately
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const t of toolUses) {
      toolCalls++;
      const handler = arm.handlers[t.name];
      const out = handler
        ? await handler(t.input).catch((e) => `tool error: ${String(e)}`)
        : `unknown tool: ${t.name}`;
      results.push({ type: "tool_result", tool_use_id: t.id, content: out });
    }
    messages.push({ role: "user", content: results });
  }

  return {
    scenario: scenario.id,
    arm: arm.name,
    trial,
    verdict,
    usage,
    wallClockMs: nowMs() - start,
    toolCalls,
    turns,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd eval && npm test`
Expected: PASS.

- [ ] **Step 5: Write the gated single-cell integration test**

Create `eval/test/runner.live.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { runCell } from "../src/runner.ts";
import { scenarios } from "../src/scenarios.ts";
import { wideSqlArm } from "../src/tools/wideSqlTools.ts";

const live = process.env.EVAL_LIVE === "1";

test("runs one S1 x wide-sql cell end to end", { skip: !live }, async () => {
  const client = new Anthropic();
  const s1 = scenarios.find((s) => s.id === "S1")!;
  const r = await runCell(s1, wideSqlArm, 1, client, () => Date.now());
  assert.ok(r.verdict, "produced a verdict");
  assert.ok(r.usage.outputTokens > 0, "captured usage");
  assert.ok(r.toolCalls > 0, "made tool calls");
  console.log(JSON.stringify(r, null, 2));
});
```

- [ ] **Step 6: Verify against live stack**

Run (stack up, API key available): `cd eval && EVAL_LIVE=1 npm test`
Expected: the S1 cell PASSES — non-null verdict, usage > 0, tool calls > 0. Paste the printed `CellResult` in the report. **This is the P2 checkpoint deliverable.**

- [ ] **Step 7: Commit**

```bash
git add eval/src/runner.ts eval/test/runner.test.ts eval/test/runner.live.test.ts
git commit -m "feat(eval): single-cell agent runner with usage capture

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Blind judge

**Files:**
- Create: `eval/src/judge.ts`, `eval/test/judge.test.ts`, `eval/test/judge.live.test.ts`

**Interfaces:**
- Consumes: `config.judgeModel`, `Scenario`, `Verdict`, `zod`, `@anthropic-ai/sdk/helpers/zod`.
- Produces:
  - `type Judgement = { pass: boolean; reasoning: string }`
  - `buildJudgePrompt(scenario: Scenario, verdict: Verdict): string` — pure; contains symptom, ground-truth RCA, rubric, agent rca + attributes; NEVER arm/tokens/time.
  - `judge(scenario: Scenario, verdict: Verdict, client: Anthropic): Promise<Judgement>`.

- [ ] **Step 1: Write the failing unit test (blindness)**

Create `eval/test/judge.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildJudgePrompt } from "../src/judge.ts";
import { scenarios } from "../src/scenarios.ts";

test("judge prompt includes ground truth + rubric + agent answer", () => {
  const s = scenarios.find((x) => x.id === "S1")!;
  const p = buildJudgePrompt(s, {
    rca: "the new-checkout-flow flag caused it",
    culprit_service: "order-service",
    discriminating_attributes: [{ key: "app.feature_flag", value: "new-checkout-flow" }],
  });
  assert.ok(p.includes(s.groundTruthRca));
  assert.ok(p.includes(s.rubric));
  assert.ok(p.includes("new-checkout-flow"));
});

test("judge prompt is blind to arm and efficiency", () => {
  const s = scenarios.find((x) => x.id === "S1")!;
  const p = buildJudgePrompt(s, { rca: "x", culprit_service: "y", discriminating_attributes: [] }).toLowerCase();
  for (const forbidden of ["wide-sql", "bubble-up", "pillars", "token", "wall", "latency", "trial", "arm "]) {
    assert.ok(!p.includes(forbidden), `prompt leaks "${forbidden}"`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd eval && npm test`
Expected: FAIL — cannot find `buildJudgePrompt`.

- [ ] **Step 3: Write judge.ts**

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { config } from "./config.ts";
import type { Scenario } from "./scenarios.ts";
import type { Verdict } from "./tools/submitVerdict.ts";

export type Judgement = { pass: boolean; reasoning: string };

const JudgementSchema = z.object({
  pass: z.boolean(),
  reasoning: z.string(),
});

// Blind: no arm, no tokens, no timing. Only the incident, the ground truth,
// the rubric, and the candidate answer.
export function buildJudgePrompt(scenario: Scenario, verdict: Verdict): string {
  const attrs = verdict.discriminating_attributes
    .map((a) => `${a.key}=${a.value}`)
    .join(", ");
  return [
    "You are grading a root-cause-analysis answer against a known ground truth.",
    "",
    `SYMPTOM PRESENTED: ${scenario.symptomPrompt}`,
    "",
    `GROUND-TRUTH ROOT CAUSE: ${scenario.groundTruthRca}`,
    "",
    `GRADING RUBRIC: ${scenario.rubric}`,
    "",
    "CANDIDATE ANSWER:",
    `  culprit service: ${verdict.culprit_service}`,
    `  discriminating attributes: ${attrs}`,
    `  explanation: ${verdict.rca}`,
    "",
    "Apply the rubric strictly. Return pass=true only if the candidate identifies the required root cause per the rubric. Give one sentence of reasoning.",
  ].join("\n");
}

export async function judge(
  scenario: Scenario,
  verdict: Verdict,
  client: Anthropic,
): Promise<Judgement> {
  const res = await client.messages.parse({
    model: config.judgeModel,
    max_tokens: 1024,
    messages: [{ role: "user", content: buildJudgePrompt(scenario, verdict) }],
    output_config: { format: zodOutputFormat(JudgementSchema) },
  });
  return res.parsed_output ?? { pass: false, reasoning: "judge produced no parseable output" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd eval && npm test`
Expected: PASS.

- [ ] **Step 5: Write the gated judge integration test**

Create `eval/test/judge.live.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { judge } from "../src/judge.ts";
import { scenarios } from "../src/scenarios.ts";

const live = process.env.EVAL_LIVE === "1";

test("judge passes a correct S1 answer and fails a wrong one", { skip: !live }, async () => {
  const client = new Anthropic();
  const s1 = scenarios.find((s) => s.id === "S1")!;
  const good = await judge(s1, {
    rca: "The new-checkout-flow feature flag in eu-west-1 caused N+1 queries and p99 latency.",
    culprit_service: "order-service",
    discriminating_attributes: [
      { key: "app.feature_flag", value: "new-checkout-flow" },
      { key: "host.region", value: "eu-west-1" },
    ],
  }, client);
  assert.equal(good.pass, true, good.reasoning);

  const bad = await judge(s1, {
    rca: "The database server ran out of disk space.",
    culprit_service: "postgres",
    discriminating_attributes: [],
  }, client);
  assert.equal(bad.pass, false, bad.reasoning);
});
```

- [ ] **Step 6: Verify against the API**

Run: `cd eval && EVAL_LIVE=1 npm test`
Expected: the judge test PASSES (good→pass, bad→fail). Paste both `reasoning` strings in the report.

- [ ] **Step 7: Commit**

```bash
git add eval/src/judge.ts eval/test/judge.test.ts eval/test/judge.live.test.ts
git commit -m "feat(eval): blind different-model judge with structured verdict grading

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Matrix runner

**Files:**
- Create: `eval/src/matrix.ts`, `eval/test/matrix.test.ts`

**Interfaces:**
- Consumes: `runCell`, `judge`, `scenarios`, the three arms, `config`.
- Produces:
  - `type JudgedResult = CellResult & { pass: boolean; judgeReasoning: string }`
  - `type MatrixOpts = { scenarioIds?: string[]; armNames?: string[]; trials?: number; concurrency?: number }`
  - `runMatrix(client: Anthropic, opts: MatrixOpts): Promise<JudgedResult[]>` — builds the cell list, runs with bounded concurrency, judges each, returns rows. `chunk<T>(items, n)` pure helper for the concurrency check.

- [ ] **Step 1: Write the failing unit test (cell enumeration + chunking)**

Create `eval/test/matrix.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCells, chunk } from "../src/matrix.ts";

test("chunk splits into bounded groups", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("buildCells produces scenario x arm x trial", () => {
  const cells = buildCells({ scenarioIds: ["S1"], armNames: ["wide-sql", "pillars"], trials: 3 });
  assert.equal(cells.length, 6); // 1 scenario x 2 arms x 3 trials
  assert.equal(cells.filter((c) => c.arm.name === "pillars").length, 3);
});

test("buildCells defaults to full matrix", () => {
  const cells = buildCells({});
  assert.equal(cells.length, 8 * 3 * 5); // 120
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd eval && npm test`
Expected: FAIL — cannot find `buildCells`/`chunk`.

- [ ] **Step 3: Write matrix.ts**

```typescript
import type Anthropic from "@anthropic-ai/sdk";
import { config } from "./config.ts";
import { scenarios, type Scenario } from "./scenarios.ts";
import { wideSqlArm } from "./tools/wideSqlTools.ts";
import { bubbleUpArm } from "./tools/bubbleUpTools.ts";
import { pillarsArm } from "./tools/pillarsTools.ts";
import type { ArmTools } from "./tools/types.ts";
import { runCell, type CellResult } from "./runner.ts";
import { judge } from "./judge.ts";

export type JudgedResult = CellResult & { pass: boolean; judgeReasoning: string };
export type MatrixOpts = {
  scenarioIds?: string[];
  armNames?: string[];
  trials?: number;
  concurrency?: number;
};

const ALL_ARMS: ArmTools[] = [wideSqlArm, bubbleUpArm, pillarsArm];

export function chunk<T>(items: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += n) out.push(items.slice(i, i + n));
  return out;
}

type Cell = { scenario: Scenario; arm: ArmTools; trial: number };

export function buildCells(opts: MatrixOpts): Cell[] {
  const scen = scenarios.filter((s) => !opts.scenarioIds || opts.scenarioIds.includes(s.id));
  const arms = ALL_ARMS.filter((a) => !opts.armNames || opts.armNames.includes(a.name));
  const trials = opts.trials ?? config.trials;
  const cells: Cell[] = [];
  for (const scenario of scen)
    for (const arm of arms)
      for (let trial = 1; trial <= trials; trial++) cells.push({ scenario, arm, trial });
  return cells;
}

export async function runMatrix(client: Anthropic, opts: MatrixOpts): Promise<JudgedResult[]> {
  const cells = buildCells(opts);
  const results: JudgedResult[] = [];
  for (const group of chunk(cells, opts.concurrency ?? config.concurrency)) {
    const batch = await Promise.all(
      group.map(async (cell) => {
        const r = await runCell(cell.scenario, cell.arm, cell.trial, client, () => Date.now());
        const j = r.verdict
          ? await judge(cell.scenario, r.verdict, client)
          : { pass: false, reasoning: "no verdict submitted" };
        return { ...r, pass: j.pass, judgeReasoning: j.reasoning };
      }),
    );
    results.push(...batch);
  }
  return results;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd eval && npm test`
Expected: PASS (3 matrix tests).

- [ ] **Step 5: Commit**

```bash
git add eval/src/matrix.ts eval/test/matrix.test.ts
git commit -m "feat(eval): matrix runner (scenario x arm x trial, bounded concurrency)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Report aggregation

**Files:**
- Create: `eval/src/report.ts`, `eval/test/report.test.ts`

**Interfaces:**
- Consumes: `JudgedResult` (Task 7).
- Produces:
  - `median(xs: number[]): number` — pure.
  - `type Cell = { arm: string; scenario: string; passRate: number; n: number; nPass: number; medTokens: number; medWallMs: number; medToolCalls: number }`
  - `aggregate(rows: JudgedResult[]): Cell[]` — group by arm×scenario; pass-rate over all trials; medians of tokens/wall/tool-calls **over passing trials only** (empty → 0).
  - `renderTable(cells: Cell[]): string` — markdown table.

- [ ] **Step 1: Write the failing test**

Create `eval/test/report.test.ts`:

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { median, aggregate } from "../src/report.ts";
import type { JudgedResult } from "../src/matrix.ts";

test("median handles odd and even lengths", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), 0);
});

function row(over: Partial<JudgedResult>): JudgedResult {
  return {
    scenario: "S1", arm: "wide-sql", trial: 1, verdict: null,
    usage: { inputTokens: 0, outputTokens: 100 }, wallClockMs: 1000,
    toolCalls: 3, turns: 4, pass: true, judgeReasoning: "", ...over,
  };
}

test("aggregate computes pass-rate over all, medians over passing only", () => {
  const rows: JudgedResult[] = [
    row({ trial: 1, pass: true, usage: { inputTokens: 0, outputTokens: 100 } }),
    row({ trial: 2, pass: true, usage: { inputTokens: 0, outputTokens: 300 } }),
    row({ trial: 3, pass: false, usage: { inputTokens: 0, outputTokens: 999 } }),
  ];
  const [cell] = aggregate(rows);
  assert.equal(cell.n, 3);
  assert.equal(cell.nPass, 2);
  assert.equal(cell.passRate, 2 / 3);
  // median tokens over the two passing rows only: median(100,300)=200
  assert.equal(cell.medTokens, 200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd eval && npm test`
Expected: FAIL — cannot find `median`/`aggregate`.

- [ ] **Step 3: Write report.ts**

```typescript
import type { JudgedResult } from "./matrix.ts";

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export type Cell = {
  arm: string;
  scenario: string;
  passRate: number;
  n: number;
  nPass: number;
  medTokens: number;
  medWallMs: number;
  medToolCalls: number;
};

export function aggregate(rows: JudgedResult[]): Cell[] {
  const groups = new Map<string, JudgedResult[]>();
  for (const r of rows) {
    const key = `${r.arm} ${r.scenario}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(r);
  }
  const cells: Cell[] = [];
  for (const [key, rs] of groups) {
    const [arm, scenario] = key.split(" ");
    const passing = rs.filter((r) => r.pass);
    cells.push({
      arm,
      scenario,
      n: rs.length,
      nPass: passing.length,
      passRate: rs.length ? passing.length / rs.length : 0,
      medTokens: median(passing.map((r) => r.usage.inputTokens + r.usage.outputTokens)),
      medWallMs: median(passing.map((r) => r.wallClockMs)),
      medToolCalls: median(passing.map((r) => r.toolCalls)),
    });
  }
  return cells.sort((a, b) => a.arm.localeCompare(b.arm) || a.scenario.localeCompare(b.scenario));
}

export function renderTable(cells: Cell[]): string {
  const header =
    "| arm | scenario | pass-rate | median tokens | median wall (ms) | median tool-calls |\n" +
    "|---|---|---|---|---|---|";
  const rows = cells.map(
    (c) =>
      `| ${c.arm} | ${c.scenario} | ${c.nPass}/${c.n} (${(c.passRate * 100).toFixed(0)}%) | ${c.medTokens} | ${c.medWallMs} | ${c.medToolCalls} |`,
  );
  return [header, ...rows].join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd eval && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add eval/src/report.ts eval/test/report.test.ts
git commit -m "feat(eval): report aggregation (pass-rate all, medians over passing)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: CLI entry, make target, methodology doc

**Files:**
- Create: `eval/src/index.ts`, `docs/eval-methodology.md`
- Modify: `Makefile`

**Interfaces:**
- Consumes: `runMatrix`, `aggregate`, `renderTable`, `config`.

- [ ] **Step 1: Write index.ts (CLI)**

```typescript
import Anthropic from "@anthropic-ai/sdk";
import { runMatrix } from "./matrix.ts";
import { aggregate, renderTable } from "./report.ts";
import { config } from "./config.ts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const scenarioIds = flag("scenario")?.split(",");
  const armNames = flag("arm")?.split(",");
  const trials = flag("trials") ? Number(flag("trials")) : undefined;
  const concurrency = flag("concurrency") ? Number(flag("concurrency")) : undefined;

  const client = new Anthropic();
  console.error(
    `Running matrix: agent=${config.agentModel} judge=${config.judgeModel} ` +
      `scenarios=${scenarioIds ?? "ALL"} arms=${armNames ?? "ALL"} trials=${trials ?? config.trials}`,
  );
  const rows = await runMatrix(client, { scenarioIds, armNames, trials, concurrency });
  const table = renderTable(aggregate(rows));
  console.log(table);
  console.error(`\n${rows.length} runs, ${rows.filter((r) => r.pass).length} passing.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 2: Add the make target**

In `Makefile`, add to the `.PHONY` list and append a target (follow the file's existing `##`-comment style):

```makefile
eval: ## Run the agent-RCA eval matrix (needs `make up` + ANTHROPIC creds). Pass ARGS="--scenario S1 --arm wide-sql --trials 1" for a subset.
	cd eval && npm run eval -- $(ARGS)
```

- [ ] **Step 3: Verify a one-cell run end to end**

Run (stack up, creds available):

```bash
make eval ARGS="--scenario S1 --arm wide-sql --trials 1"
```

Expected: prints a one-row markdown table for `wide-sql / S1` with a pass-rate and medians, and a run summary on stderr. Paste the output in the report.

- [ ] **Step 4: Write the methodology doc**

Create `docs/eval-methodology.md` covering: the falsifiable claim; the three arms and that only tools differ (INV-2); INV-1 (high-card discriminators absent from RED metrics, present in logs/traces; region legitimate; S6 tie; S5 scored on build_id+pod); the blind different-model judge; pinned models (`claude-sonnet-5` agent, `claude-opus-4-8` judge) and the P0 pinned image digests; the reproduction path (`make up` → `bash scripts/verify-inv1.sh` → `make eval`); and that efficiency is reported only for judge-passing runs, as distributions not single numbers. Reference `docs/superpowers/specs/2026-07-04-eval-harness-p1-p3-design.md` for the design.

- [ ] **Step 5: Typecheck + full unit suite**

Run: `cd eval && npm run typecheck && npm test`
Expected: typecheck clean; all unit tests pass (live tests skipped).

- [ ] **Step 6: Commit**

```bash
git add eval/src/index.ts docs/eval-methodology.md Makefile
git commit -m "feat(eval): CLI entry, make eval target, methodology doc

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** §1 layout → Task 1; §2 arms/tools + submit_verdict → Task 4; §3 scenarios/judge → Tasks 3, 6; §4 runner/metrics → Tasks 5, 7; §5 report → Task 8; §6 testing → gated integration tests throughout; §7 phases: P1 = Tasks 1–4, P2 (checkpoint) = Tasks 5–6, P3 = Tasks 7–9.
- **Fairness enforced in code:** identical `SYSTEM_PROMPT`, symptom prompt, model, `truncateCap` across arms (only `arm.definitions`/`handlers` differ); judge prompt asserted blind by `judge.test.ts`.
- **Correction:** the harness uses the Anthropic TypeScript SDK's manual tool-use loop (not the "Claude Agent SDK" named loosely in the spec) — the accurate primitive for in-process custom tools with precise terminal-tool control and per-turn usage capture.
- **P2 checkpoint:** Task 5 Step 6 (one live cell) and Task 6 Step 6 (judge good/bad) are the "harness proven before the full 240-call spend" gate. Do not run the full matrix (Task 9 full `make eval`) until these pass.
- **Deferred (spec §8):** multi-model sweep and statistical significance beyond median±spread.
- **Type consistency:** `Usage`, `CellResult`, `Verdict`, `JudgedResult`, `Cell`, `ArmTools`, `Scenario`, `Attr` are defined once and reused; `arm.name` values (`wide-sql`/`bubble-up`/`pillars`) match across tools, matrix, and report.
- **Watch item for the implementer:** the `@heatmap/shared-comparison/src/sqlFilters` import path (Task 4 Step 5) may need adjustment under NodeNext resolution — the typecheck in Task 4 Step 7 is the gate; fall back to the package-root export if the deep path fails.
