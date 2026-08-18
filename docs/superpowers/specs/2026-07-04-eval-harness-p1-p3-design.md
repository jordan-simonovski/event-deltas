# Agent-RCA Eval Harness (P1–P3) — Design Addendum

**Status:** Design approved 2026-07-04. Extends `2026-07-03-wide-events-vs-three-pillars-eval-design.md` with the concrete P1–P3 implementation decisions. P0 (data plane) is merged (PR #53).

This addendum records the *how* for the phases the original spec described at the *what* level. Where this document and the original spec disagree, this one governs for P1–P3.

---

## 1. Runtime & layout

New top-level `eval/` package: **TypeScript, Node, Claude Agent SDK**. TS chosen so arm B can reuse the existing bubble-up SQL builders in `packages/shared-comparison` rather than reimplementing select/compare/rank.

```
eval/
  package.json            # @anthropic-ai/claude-agent-sdk, clickhouse client, node fetch
  src/
    backends/             # thin query executors, one job each
      clickhouse.ts       # clickhouseSql(query) -> rows        (arms A/B)
      prometheus.ts       # promql(query) -> result             (arm C)
      loki.ts             # logql(query) -> streams             (arm C)
      tempo.ts            # traceql(query) -> traces            (arm C)
    tools/
      wideSqlTools.ts     # arm A tool set
      bubbleUpTools.ts    # arm B tool set (wraps shared-comparison)
      pillarsTools.ts     # arm C tool set
      submitVerdict.ts    # shared terminal tool (all arms)
    scenarios.ts          # S1–S8: symptom prompt, canonical RCA, discriminators, rubric
    runner.ts             # matrix runner + usage capture
    judge.ts              # blind LLM judge
    report.ts             # aggregation -> results table
    config.ts             # models, N trials, backend URLs (env-overridable)
  results/                # run output (git-ignored; a sample table may be committed)
  test/                   # unit + integration (smoke) tests
```

Backend URLs default to the `make up` host ports (ClickHouse 8123, Prometheus 9090, Loki 3100, Tempo 3200), env-overridable.

## 2. Three arms — same everything, different tools

Every arm shares an identical **system prompt** ("you are an SRE performing root-cause analysis; investigate with your tools; when confident, call `submit_verdict`"), identical **symptom prompt** (INV-2), identical **agent model**, and identical **trial count**. The ONLY difference is the tool set:

| Arm | Tools |
|-----|-------|
| **A. wide/SQL** | `clickhouse_sql` |
| **B. wide/bubble-up** | `clickhouse_sql`, `select_region`, `compare_baseline`, `rank_attributes` (reuse `shared-comparison`) |
| **C. three pillars** | `promql`, `loki_logql`, `traceql` |

Every arm additionally gets **`submit_verdict`**, the terminal tool the agent must call to finish. Schema:

```ts
{ rca: string, culprit_service: string, discriminating_attributes: {key: string, value: string}[] }
```

The runner reads `submit_verdict`'s arguments directly — no free-text parsing of the final message.

Each query tool executes the **agent-authored** query string against the backend and returns results (rows/series/streams/traces). The tool never rewrites or enriches the query — the friction of authoring PromQL/LogQL/TraceQL/SQL by hand is exactly what the benchmark measures. Result payloads are truncated to a documented cap (so token accounting isn't dominated by one giant result), and the cap is identical across arms.

## 3. Scenarios & judge

`scenarios.ts` holds S1–S8. Each entry:

```ts
{ id, symptomPrompt, groundTruthRca, discriminatingAttributes: {key,value}[], rubric }
```

- Symptom prompts name the symptom, never the cause (e.g. "checkout p99 latency SLO is burning over the last 15 min — find the root cause"). Derived from the scenario table in `trace-generator/main.go`.
- **S5** is scored on `app.build_id` + `k8s.pod.name` (both are span AND log attributes; every arm can reach them). The infra saturation USE metrics are realistic incidental signal for arm C, not a scored shortcut — documented in the scenario note.
- **S6** (region-only) is the documented **expected tie**: region is a legitimate metric label, so it's metrics-solvable in all arms. Reported as a draw, not a wide-events win.
- **S3** discriminates on `db.system=redis`, which is **low-cardinality but absent from the RED metrics** (it is not a `spanmetrics` dimension — it lives only on trace leaf spans). The fairness criterion for a rubric is therefore "the discriminator is **absent from the RED metrics**, forcing a logs/traces pivot" — NOT strictly "high-cardinality" (decided 2026-07-04). S3 is a valid wide-events case on that basis: metrics scope it to a region, but only a trace query reveals it's Redis. Its rubric requires naming Redis and notes db.system is trace-only.

The **judge** (`judge.ts`) receives only `{ symptomPrompt, groundTruthRca, rubric, agent's rca text + claimed discriminating_attributes }` → `{pass: boolean, reasoning: string}`. It is:
- **blind to arm** (never told which tool set produced the answer),
- **blind to efficiency** (never sees tokens/time — cannot reward brevity),
- **on a different model** than the agent,
- **rubric-driven** (per-scenario criteria, not improvised).

The judge is the correctness gate only. Its `reasoning` is retained for audit; it never influences efficiency metrics.

## 4. Runner & metrics

```
for scenario in S1..S8:
  for arm in [A, B, C]:
    for trial in 1..N (N=5):
      fresh agent session (system prompt + symptom prompt + arm tools + submit_verdict)
      run to completion (agent loops, queries, calls submit_verdict)
      capture: input_tokens, output_tokens, wall_clock_ms, tool_calls, turns
      verdict = submit_verdict args
      judged = judge(verdict, scenario)   # blind
      record row {scenario, arm, trial, judged.pass, tokens, wall_clock_ms, tool_calls, turns}
```

- **Usage** comes from the SDK's reported token accounting, not estimation. Wall-clock is a timer around the session.
- **Efficiency metrics are reported only for judge-passing runs.** A cheap wrong answer is not a win.
- **Matrix:** 8 × 3 × 5 = **120 agent runs + 120 judge runs**, one held-constant capable agent model + a different judge model, both **pinned by version in the methodology doc**.
- **Subset mode:** `--scenario S1 --arm C --trials 1` for cheap dev iteration without the full spend. `--concurrency N` bounds parallel sessions.
- A fresh agent per cell — no carryover between trials or arms.

## 5. Report

`report.ts` aggregates rows → a table: rows = arm × scenario, columns = pass-rate, median tokens, median wall-clock, median tool-calls (with spread). Plus a methodology section: the falsifiable claim, fairness invariants (INV-1 region-scoping + S5/S6 notes + INV-2), pinned image digests (from P0) and pinned model versions, and the reproduction path (`make up` → `verify-inv1.sh` → `eval` run). No single-run numbers — distributions only.

## 6. Testing

- **Unit (deterministic):** scenario well-formedness (every scenario has all fields; discriminators non-empty; S6 flagged tie), `submit_verdict` schema validation, report aggregation math (median/pass-rate/spread on fixture rows), judge-prompt construction (asserts arm/efficiency info is absent — the blindness guarantee), and the arm-B tool query builders (reused `shared-comparison` output).
- **Integration (smoke, against live `make up`):** each backend executor runs a real query and returns non-empty results; one full single-cell run (`--scenario S1 --arm A --trials 1`) produces a verdict + judge result + usage.
- Agent runs themselves are not unit-tested (they hit the API). Their plumbing (verdict capture, usage extraction, judge gating) is.

## 7. Phases (one plan, one PR, checkpoint at P2)

- **P1 — tool surfaces:** `backends/` executors, per-arm `tools/`, `scenarios.ts` (symptom prompts, ground-truth RCAs, rubrics), `submit_verdict`. Deliverable: every tool executes a real query against the live stack (smoke test green).
- **P2 — harness + judge (single cell):** `runner.ts` for one cell, usage capture, `judge.ts` (blind, different model). Deliverable: one (scenario × arm) runs end-to-end → verdict + pass/fail + usage. **Review checkpoint here before the full-matrix spend.**
- **P3 — run + report:** scale runner to the full matrix (concurrency, trials), `report.ts` aggregation, methodology doc, `make eval` target. Deliverable: the results table from a full run.

## 8. Defaults chosen (knobs)

- N = 5 trials; matrix concurrency configurable.
- Single capable agent model held constant across arms; judge on a different model; both env-configurable and pinned in the methodology doc at run time.
- Result-payload truncation cap identical across arms (documented value).
- Multi-model sweep and statistical-significance testing beyond median±spread are explicit later extensions, out of scope here.

## 9. Risks

- **API cost/keys:** the full P3 run needs an Anthropic API key and spends real tokens (~240 model calls). Subset mode keeps dev free of that. The full run is a deliberate, gated step (P2 checkpoint precedes it).
- **Judge variance:** mitigated by rubric + blindness + different model + 5 trials; report judge disagreement rate if non-trivial.
- **Result truncation bias:** the cap could hide signal differently across arms; keep it identical and documented, and sanity-check that no arm's correctness hinges on truncated output.
- **Tool-authoring realism:** the query tools must not smooth over query-language friction (no auto-fixing malformed PromQL/LogQL/TraceQL); a failed query returns the backend's real error so the agent pays the correction cost, equally across arms.
