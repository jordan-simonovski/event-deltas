# Changelog

## 2.0.0

### Major Changes

- [#68](https://github.com/jordan-simonovski/event-deltas/pull/68) [`f95dc75`](https://github.com/jordan-simonovski/event-deltas/commit/f95dc751cd2a21dab9246f021aa749cfb28d8b3f) Thanks [@jordan-simonovski](https://github.com/jordan-simonovski)! - Rename Heatmap Bubbles to Event Deltas. "Bubbles" read as the bubble-up
  technique rather than a product name.

  This is breaking. Plugin IDs change (`jordo-heatmap-bubbles-panel` ->
  `jordo-event-deltas-panel`, `jordo-heatmap-bubbles-app` ->
  `jordo-event-deltas-app`, `jordo-slo-bubbles-app` -> `jordo-slo-app`), so app
  URLs move, the unsigned-plugin allowlist needs updating, and dashboards that
  reference the old panel type will not resolve it. The cross-plugin selection
  event channel also changes from `heatmap-bubbles-selection` to
  `event-deltas-selection`, so all four plugins must be upgraded together.

### Minor Changes

- [#68](https://github.com/jordan-simonovski/event-deltas/pull/68) [`4486b33`](https://github.com/jordan-simonovski/event-deltas/commit/4486b337845fcee6c30f28ceb075f8587852214c) Thanks [@jordan-simonovski](https://github.com/jordan-simonovski)! - Prepare the plugins for Grafana catalog submission: real author, catalog links
  and screenshots in plugin.json, a proper README per plugin, and
  `grafanaDependency` raised
  to `>=12.0.0` to match the `@grafana/*` 12.3 dependencies the plugins are
  actually built and tested against.

- [#68](https://github.com/jordan-simonovski/event-deltas/pull/68) [`1bdbfaa`](https://github.com/jordan-simonovski/event-deltas/commit/1bdbfaaee807e2bc9496cef4a9233d606b0b92b2) Thanks [@jordan-simonovski](https://github.com/jordan-simonovski)! - Make Event Deltas statistically sound.

  The heatmap sampled with `ORDER BY Timestamp LIMIT 10000`, which returns the
  _oldest_ 10k spans rather than a sample. Measured on the demo stack, that was
  54 seconds of a 900-second window — 6% of the data, all of it from the opening
  of the range, and the comparison inherited the bias through the selected trace
  IDs. Sampling is now `ORDER BY cityHash64(TraceId)`, which covers the whole
  window at the same row count and stays stable across refreshes. Sample size is
  tunable in the app via a new "Sample size" control (1k-50k, default 10k).

  The comparison itself was up to 102 queries per selection — two per attribute,
  each computing percentages over its own truncated top-20 denominator. It is now
  one query whose group totals come from a window function evaluated before the
  per-attribute limit, so percentages use real denominators.

  Ranking is now confidence-adjusted: the lower bound of the 95% Agresti-Caffo
  interval on the difference in proportions, so a value seen three times can no
  longer outrank one seen nine hundred times. Cards still display the observed
  difference; only the ordering and the "is this signal at all" decision use the
  adjusted score. Values below five occurrences and identifier-like attributes
  (user.id, db.statement) are dropped.

  Direction is unchanged: a value is still only signal when it is
  over-represented in the selection.

### Patch Changes

- [#68](https://github.com/jordan-simonovski/event-deltas/pull/68) [`1502314`](https://github.com/jordan-simonovski/event-deltas/commit/15023142e74434a26b60efa3fd879d29892ac119) Thanks [@jordan-simonovski](https://github.com/jordan-simonovski)! - Declare the panel plugins the apps embed. Both render panels by plugin ID —
  Event Deltas in the app's explorer, Event Deltas and Timeseries Selection in
  the SLO drilldown — but shipped with an empty `dependencies.plugins`, so
  installing an app on its own left a missing-panel box where the main
  visualisation should be.

## 1.1.0

### Minor Changes

- [#50](https://github.com/jordan-simonovski/heatmap-investigation/pull/50) [`6a5e19a`](https://github.com/jordan-simonovski/heatmap-investigation/commit/6a5e19a6042afd5a76cfc355a9f96b0038bf57ef) Thanks [@jordan-simonovski](https://github.com/jordan-simonovski)! - Made a glowy boi for the error insights panel as a CTA

- [#51](https://github.com/jordan-simonovski/heatmap-investigation/pull/51) [`fe3ed59`](https://github.com/jordan-simonovski/heatmap-investigation/commit/fe3ed59527ef032de6ba865436532398ad70c86b) Thanks [@jordan-simonovski](https://github.com/jordan-simonovski)! - Saturation via wide events: box-select now also answers "was the infra saturated?" —
  ranked resource cards (p95 during selection vs baseline, straight off raw OTel metric rows
  in ClickHouse) plus an ambient saturation strip under the heatmap showing one line per
  service so a single service crossing into saturation is visible before you select. No
  metrics store, no dashboards, no new services — just query-time SQL over wide events.

## 1.0.3

### Patch Changes

- [#46](https://github.com/jordan-simonovski/heatmap-investigation/pull/46) [`b5d517d`](https://github.com/jordan-simonovski/heatmap-investigation/commit/b5d517de6841bb7c63ced6b696fbde5ebcc2982c) Thanks [@jordan-simonovski](https://github.com/jordan-simonovski)! - chore: harden the release pipeline — skip already-signed versions (HTTP 409) instead of failing the whole publish, and point changelog links at the renamed repo (heatmap-investigation)

## 1.0.2

### Patch Changes

- [#44](https://github.com/jordan-simonovski/heatmap-investigation/pull/44) [`13e2238`](https://github.com/jordan-simonovski/heatmap-investigation/commit/13e2238b6b573e086a92bd735d59be840d76c3ca) Thanks [@jordan-simonovski](https://github.com/jordan-simonovski)! - chore: bump transitive npm dependencies to resolve open Dependabot PRs (qs, serialize-javascript, protobufjs, @protobufjs/utf8, fast-uri, picomatch, protocol-buffers-schema, lodash, flatted, yaml, copy-webpack-plugin, terser-webpack-plugin)

## 1.0.1

### Patch Changes

- [#41](https://github.com/jordan-simonovski/heatmap-investigation/pull/41) [`75c64ff`](https://github.com/jordan-simonovski/heatmap-investigation/commit/75c64fff633be616f96669860b53916b742ba6f7) Thanks [@jordan-simonovski](https://github.com/jordan-simonovski)! - chore: patch bumped dependencies to resolve vulns

## 1.0.0 (Unreleased)

Initial release.
