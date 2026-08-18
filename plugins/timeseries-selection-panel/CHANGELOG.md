# Changelog

## 3.0.0

### Major Changes

- [#73](https://github.com/jordan-simonovski/event-deltas/pull/73) [`162a02d`](https://github.com/jordan-simonovski/event-deltas/commit/162a02d97bad09d717d64a0cafeb1a486519b6cb) Thanks [@jordan-simonovski](https://github.com/jordan-simonovski)! - Use plugin IDs the Grafana catalog accepts.

  Submission rejects any archive whose id fails
  `^[0-9a-z]+-([0-9a-z]+-)?(app|panel|datasource)$` — at most `<org>-<name>-<type>`,
  and `<name>` cannot contain a dash of its own.

  ```
  jordo-event-deltas-panel         -> jordo-eventdeltas-panel
  jordo-event-deltas-app           -> jordo-eventdeltas-app
  jordo-timeseries-selection-panel -> jordo-timeseries-panel
  jordo-slo-app                      unchanged, it already passed
  ```

  Breaking for the same reasons as the last rename: app URLs move, the unsigned
  plugin allowlist needs updating, and dashboards referencing the old panel types
  will not resolve them. Display names are untouched, and the selection event
  channel keeps its `event-deltas-` prefix, which is not an id and has no such
  constraint. The slo-app bump is a patch because only its dependency references
  changed.

## 2.0.1

### Patch Changes

- [#70](https://github.com/jordan-simonovski/event-deltas/pull/70) [`d1e2d73`](https://github.com/jordan-simonovski/event-deltas/commit/d1e2d738b2d96754ef2890a71bb47ad384298b9a) Thanks [@jordan-simonovski](https://github.com/jordan-simonovski)! - Point the catalog links at the repository's current name. It was renamed to
  `event-deltas`; the old links redirect, but the catalog page and the plugin
  submission's source URL should be canonical.

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

### Patch Changes

- [#68](https://github.com/jordan-simonovski/event-deltas/pull/68) [`fafd8e6`](https://github.com/jordan-simonovski/event-deltas/commit/fafd8e61c15f679671321a6d033961fedc57b9d9) Thanks [@jordan-simonovski](https://github.com/jordan-simonovski)! - Add a catalog screenshot showing a brush selection driving attribute comparison.

## 1.0.2

### Patch Changes

- [#46](https://github.com/jordan-simonovski/heatmap-investigation/pull/46) [`b5d517d`](https://github.com/jordan-simonovski/heatmap-investigation/commit/b5d517de6841bb7c63ced6b696fbde5ebcc2982c) Thanks [@jordan-simonovski](https://github.com/jordan-simonovski)! - chore: harden the release pipeline — skip already-signed versions (HTTP 409) instead of failing the whole publish, and point changelog links at the renamed repo (heatmap-investigation)

## 1.0.1

### Patch Changes

- [#44](https://github.com/jordan-simonovski/heatmap-investigation/pull/44) [`13e2238`](https://github.com/jordan-simonovski/heatmap-investigation/commit/13e2238b6b573e086a92bd735d59be840d76c3ca) Thanks [@jordan-simonovski](https://github.com/jordan-simonovski)! - chore: bump transitive npm dependencies to resolve open Dependabot PRs (qs, serialize-javascript, protobufjs, @protobufjs/utf8, fast-uri, picomatch, protocol-buffers-schema, lodash, flatted, yaml, copy-webpack-plugin, terser-webpack-plugin)

## 1.0.0

- Initial release
