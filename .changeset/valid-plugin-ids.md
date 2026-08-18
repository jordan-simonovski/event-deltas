---
'heatmap-panel': major
'timeseries-selection-panel': major
'heatmap-app': major
'slo-app': patch
---

Use plugin IDs the Grafana catalog accepts.

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
