# Event Deltas

A latency heatmap panel with box selection. Drag a box over a cluster of slow or
failing requests and the panel publishes the selection on Grafana's app event
bus, so another panel can compare that cohort against the rest of the traffic.

## Requirements

- Grafana 12.0 or later.
- A query returning one row per span or request. The panel matches fields by
  name, case-insensitively:

  | Field                                       | Required | Notes                                     |
  | ------------------------------------------- | -------- | ----------------------------------------- |
  | a time field, or one named `timestamp`      | yes      | x-axis                                    |
  | `duration`, `duration_ms` or `durationNano` | yes      | y-axis                                    |
  | `traceID` / `trace_id`                      | no       | ids are attached to the selection payload |
  | `isError` / `is_error`                      | no       | needed for the Error Rate color mode      |

Any data source that can produce those fields works. The bundled demo stack uses
ClickHouse with OpenTelemetry trace data.

## Usage

Add the panel to a dashboard, point it at a query as above, then drag a box on
the heatmap. The panel emits an `event-deltas-selection` event carrying the
selected time range, latency range, trace ids and span count; clearing the
selection emits `event-deltas-selection-clear`. The Event Deltas App
consumes those events to show what is different about the selected traces.

## Options

| Option         | Default     | Description                                    |
| -------------- | ----------- | ---------------------------------------------- |
| Y-axis scale   | Logarithmic | Linear or logarithmic latency axis             |
| Color scheme   | Blues       | Blues, Greens, Oranges or Reds                 |
| Color mode     | Count       | Color cells by request count, or by error rate |
| Y-axis buckets | 40          | Number of latency buckets (10-100)             |

## Installation

Download the zip from the [releases page](https://github.com/jordan-simonovski/event-deltas/releases)
and unzip it into Grafana's plugin directory. Until the plugin is signed, allow
it to load:

```
GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=jordo-event-deltas-panel
```

## Development

From the repository root:

```bash
npm ci
npm run build --workspace=plugins/heatmap-panel
```

`make up` in the repository root starts Grafana, ClickHouse and a synthetic
trace generator with the plugin already provisioned.

## License

Apache-2.0. See [LICENSE](./LICENSE).
