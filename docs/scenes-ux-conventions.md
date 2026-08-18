# Scenes UX Conventions

## Purpose

This document defines UI/UX conventions for Scenes-based investigation apps in this repository. The goal is high information density with continuous root-cause analysis flow.

## Core Rules

- Every investigation page must expose at least two meaningful next actions.
- Never end a page with static information only; include pivot controls.
- Keep route generation centralized through constants/helpers; avoid hardcoded `/a/...` strings in scene code.
- Use theme tokens for colors/spacing/typography; only use raw colors for semantic severity scales.
- Empty and loading states must include actionable guidance, not generic placeholders.

## Recommended Scene Structure

- Controls row: time range, refresh, variables, state controls.
- Investigation guidance block: summary + next actions + compact KPI badges.
- Primary evidence panel: heatmap or timeseries selection surface.
- Differential analysis panel: baseline vs selection comparison.
- Evidence validation panel: representative traces and trace drilldown links.

## Cross-App Navigation

- SLO app pivots to Heatmap app through route helpers in `slo-app/src/utils/crossAppRoutes.ts`.
- Heatmap app trace details must always provide return actions to explorer/comparisons/evidence routes.
- Do not use direct path literals for cross-app trace links.

## Filter Semantics

- `StatusCode` and `ServiceName` are top-level columns and must map directly in SQL predicates.
- Non top-level ad-hoc keys map to `SpanAttributes['<key>']`.
- All ad-hoc filter values must be SQL-escaped.

## Selection Lifecycle

- Selection publish event: `event-deltas-selection`.
- Selection clear event: `event-deltas-selection-clear`.
- Heatmap and timeseries selection panels must both publish on the same channels.
- Shared selection state must clear downstream views when clear events are published.
