# Wide-Events vs Three-Pillars: Agent RCA Eval Harness

**Status:** Design approved 2026-07-03. Not yet implemented.
**Author:** Jordan Simonovski
**Scope:** A reproducible, publishable benchmark that tests whether an agent performs automated root-cause analysis more cheaply over wide events than over the traditional three pillars.

---

## 1. The claim, stated falsifiably

> Given the *same* incident and the *same* agent/model, an agent reaches a correct
> root-cause conclusion using **fewer tokens and less wall-clock** when querying wide
> events than when stitching across three pillars (metrics + logs + traces) — without
> sacrificing correctness.

The claim is falsified if, across the scenario matrix, the three-pillars arm is not
meaningfully more expensive at equal correctness — or if the wide-events arms win only
because they were handed an easier problem (a strawman, in either direction).

### Metrics

Captured per run:

- **Correctness** (gate): pass/fail from a blind LLM judge (§5).
- **Total tokens**: input + output, summed across all agent turns.
- **Wall-clock**: end-to-end run duration.
- **Tool-call count** and **turn count**.

Efficiency metrics are only compared **conditioned on the judge passing**. A cheap wrong
answer is not a win. Report per (arm × scenario): pass-rate, and median + spread of each
efficiency metric over N trials. Never report a single-run number as a result.

---

## 2. Three arms, one workload

Identical workload across arms: same S1–S8 scenarios, same natural-language symptom
prompt, same held-constant agent model. **Only the tool surface differs.**

| Arm | Tools the agent gets | Effect it isolates |
|-----|----------------------|--------------------|
| **A. Wide / raw SQL** | one ClickHouse SQL tool over `otel_traces` | wide-events **data model** |
| **B. Wide / bubble-up** | A's SQL tool + the select/compare/rank bubble-up primitives as tools | our **product** on top of the data model |
| **C. Three pillars** | Prometheus (PromQL) + Loki (LogQL) + Tempo (TraceQL), each a native tool | the **status quo** |

Separating A from B lets us answer two distinct questions: *is the data model cheaper?*
(A vs C) and *does our investigation grammar add further leverage?* (B vs A). A skeptic
who dismisses B as "your UI did the work" still has to contend with A.

---

## 3. Data plane — the fairness core

`trace-generator` already emits OTLP (traces + metrics) to the OTel collector. The
collector **fans one stream out**:

- **everything → ClickHouse** (`otel_traces`, existing) — feeds arms A and B
- **traces → Tempo**, **metrics → Prometheus**, **logs → Loki** — feeds arm C

New services added to `docker/docker-compose.yml`, **pinned by digest** (the positioning
bar forbids `latest` for anything benchmarked): Tempo, Prometheus, Loki.

Because the same generator stream is the source for all arms, the arms are guaranteed to
be describing the *same underlying incidents*. No arm sees data another arm doesn't.

### Two hard fairness invariants

These are exactly what a hostile reviewer will attack. They are non-negotiable.

**INV-1 — Solvable-but-scattered (don't handicap the pillars arm).**
Every scenario's discriminating attributes (S1 = `feature_flag` + `region`; S2 =
`platform` + `build_id`; … the full table in `trace-generator/main.go`) must be
*reachable* in arm C. But they are scattered the way real three-pillars stacks scatter
them: **high-cardinality attributes (tenant, pod, build, flag) are aggregated out of the
metrics pillar** and survive only in logs and/or traces. That aggregation loss is the
pain we are measuring — but the answer must remain reachable via *some* pillar.

Concretely: metrics carry only low-cardinality labels (service, route, region, status
class). Logs and trace spans carry the full attribute set. So the pillars agent can
detect *that* something is wrong from metrics, but must pivot to logs/traces (and switch
query language) to find *what* — which is the realistic, and costly, workflow.

Consequence: `trace-generator` must **emit logs** (it currently emits only traces +
metrics). Log lines carry the same per-request attributes the spans do, so the fact
exists in arm C even after metric aggregation strips it.

**Corollary — region is legitimately in metrics, so region-only scenarios are a tie
(decided 2026-07-03).** Because `host.region` is a genuinely low-cardinality dimension
that real RED metrics carry, it is a `spanmetrics` label in arm C — *by design*, not a
leak. The wide-events advantage is therefore measured only on the **high-cardinality**
discriminators (`feature_flag`, `tenant`, `build_id`, `pod`, `platform`) that are truly
absent from metrics and force the pivot to logs/traces. This has a deliberate,
honesty-preserving consequence: **S6 (region-only discriminator) is metrics-solvable in
both arms — an expected tie, not a wide-events win.** Reporting S6 as a draw strengthens
credibility (the benchmark isn't cherry-picked). The INV-1 gate's high-cardinality
blocklist therefore intentionally excludes `host.region` (and `route`/`status`/`service`).

**INV-2 — Same starting line (don't advantage the wide-events arms).**
All three arms start from *one identical* natural-language symptom prompt, e.g.:

> "The SLO for checkout p99 latency has been burning over the last 15 minutes.
> Find the root cause."

No arm gets a pre-narrowed heatmap selection, a hint, or a starting query the others
lack. Arm B may *use* bubble-up primitives, but it is not *pointed* at the answer.

---

## 4. Harness

Runtime: **Claude Agent SDK**, driven by a single runner.

```
for scenario in S1..S8:
  for arm in [A, B, C]:
    for trial in 1..N:      # N default 5, knob
      spawn fresh agent(model=M, tools=arm.tools)
      send scenario.symptom_prompt
      require a structured final verdict
      record usage: tokens, wall-clock, tool_calls, turns
      judge the verdict (§5)
```

- **Fresh agent per run** — no carryover between trials or arms.
- **Model M held constant** across all arms (default: one capable model; a knob).
- **Structured final verdict**: the agent must end with a machine-readable object —
  free-text RCA + `culprit_service` + `discriminating_attributes` (key/value list). The
  free text is what the judge grades; the structured fields aid auditing and partial
  analysis.
- **Usage capture** comes from the SDK's reported token accounting, not estimation.
- **N trials** for variance; results are distributions, not points.

The tool surfaces (three MCP configs) are the P1 deliverable:

- **SQL tool**: parametrised ClickHouse query execution over `otel_traces`.
- **Bubble-up primitives**: select-region / compare-vs-baseline / rank-attributes,
  mirroring the grammar in `packages/shared-comparison`.
- **PromQL / LogQL / TraceQL tools**: query execution against Prometheus, Loki, Tempo
  respectively — three separate tools, native query languages, no shared join key handed
  to the agent (it must correlate by timestamp/trace-id itself, as in real life).

---

## 5. Judge

Correctness is graded by an **LLM judge**, not by exact string match, because a correct
RCA can be phrased many ways.

- Each scenario has a **canonical written ground-truth RCA**, committed alongside the
  harness (the S-table in `trace-generator/main.go` is the source of truth for the
  discriminating attributes).
- The judge compares the agent's free-text conclusion against the canonical RCA using a
  **per-scenario rubric** → pass/fail (optionally partial-credit, but pass/fail is the
  gate).

Anti-"who-judges-the-judge" defenses (all required):

1. **Blind to arm** — the judge never learns which arm produced an answer.
2. **Blind to efficiency** — the judge never sees tokens/time; it cannot reward brevity.
3. **Different model** — judge runs on a different model than the agent (a knob), so the
   agent can't "win" by matching its own judge's phrasing.
4. **Rubric-driven** — the grading criteria are written per scenario, not improvised.

---

## 6. Output

- A **results table**: rows = arm × scenario, columns = pass-rate, median tokens, median
  wall-clock, median tool-calls, with spread.
- A **methodology document** written to publishing standard: the falsifiable claim, the
  two fairness invariants and how they're enforced, pinned image digests, the exact
  reproduction path, and the S-scenario workload description.
- **Reproducibility**: a stranger runs `make up` then `make eval` (new target) on a clean
  machine and regenerates the table. Pinned digests are stated in the methodology doc.

This clears the §4 reproducibility standard in the positioning skill: observable from a
clean `make up`, pinned digests for the benchmarked stack, deterministic S1–S8 workload,
honest incidence arithmetic (rates derived from `trace-generator` constants, not stale
docs — cf. the S6 cautionary tale).

---

## 7. Build phases

Each phase is independently reviewable and could become its own implementation plan.

- **P0 — Data plane** (heavy lift, credibility keystone)
  - Add logs emission to `trace-generator` (same per-request attributes as spans).
  - Extend the collector to fan out: traces→Tempo, metrics→Prometheus, logs→Loki, while
    keeping the existing ClickHouse export.
  - Add Tempo, Prometheus, Loki to docker-compose, pinned by digest.
  - Enforce INV-1: verify each scenario's discriminating attributes are aggregated out of
    metrics but present in logs/traces.

- **P1 — Tool surfaces**
  - SQL MCP tool over `otel_traces`.
  - Bubble-up primitive tools mirroring `shared-comparison`.
  - PromQL / LogQL / TraceQL MCP tools.

- **P2 — Harness + judge**
  - Agent SDK runner over the (scenario × arm × trial) matrix.
  - Structured verdict schema.
  - Canonical ground-truth RCAs + per-scenario judge rubrics.
  - Blind, different-model judge.

- **P3 — Run + report**
  - Execute the matrix; collect distributions.
  - Results table + methodology writeup.
  - `make eval` target and clean-machine reproduction check.

---

## 8. Risks and fallbacks

- **P0 cost.** Three real backends + logs emission is the bulk of the work and the
  credibility keystone. Decided in favour of real stacks (Prometheus/Loki/Tempo) over
  faithful mocks, accepting the cost. Fallback *only if P0 proves disproportionate*:
  faithful in-repo mocks for arm C, documented as a stand-in — but this weakens the
  publishable claim and is a last resort, not a default.
- **INV-1 misconfiguration** (the answer becomes unreachable in arm C, or trivially
  reachable in metrics) would invalidate the comparison. P0 must include an explicit
  check that each scenario is solvable-but-scattered.
- **Judge variance.** Mitigated by rubric + blindness + different model + multiple trials;
  report judge disagreement rate if non-trivial.
- **Model drift.** Pin the agent model and judge model versions in the methodology doc,
  same as image digests.

---

## 9. Defaults chosen (knobs)

- N = 5 trials per (scenario × arm).
- Agent model held constant; judge on a different model.
- Symptom prompts are latency/error framed per scenario, never naming the culprit.
- All S1–S8 in scope.
