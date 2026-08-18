---
'heatmap-panel': major
'timeseries-selection-panel': major
'heatmap-app': major
'slo-app': major
---

Rename Heatmap Bubbles to Event Deltas. "Bubbles" read as the bubble-up
technique rather than a product name.

This is breaking. Plugin IDs change (`jordo-heatmap-bubbles-panel` ->
`jordo-event-deltas-panel`, `jordo-heatmap-bubbles-app` ->
`jordo-event-deltas-app`, `jordo-slo-bubbles-app` -> `jordo-slo-app`), so app
URLs move, the unsigned-plugin allowlist needs updating, and dashboards that
reference the old panel type will not resolve it. The cross-plugin selection
event channel also changes from `heatmap-bubbles-selection` to
`event-deltas-selection`, so all four plugins must be upgraded together.
