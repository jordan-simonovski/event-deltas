# Event Deltas App

A trace analysis workbench built on [Grafana Scenes](https://grafana.com/developers/scenes).
Select a cluster of slow or failing requests on a latency heatmap, and the app
tells you what those requests have in common that the rest of your traffic does
not — platform, build id, region, tenant, feature flag, pod, and so on.

This is the "bubble up" workflow: instead of picking a dashboard per hypothesis,
you select the anomaly you can see and let the attribute comparison rank the
candidate causes for you.

## Requirements

- Grafana 12.0 or later.
- The [ClickHouse data source](https://grafana.com/grafana/plugins/grafana-clickhouse-datasource/).
- OpenTelemetry trace data in ClickHouse — the schema the OpenTelemetry
  Collector's ClickHouse exporter creates by default.

## Configuration

**Administration > Plugins > Event Deltas App > Configuration**:

| Setting | Default | Description |
|---|---|---|
| Data source | `clickhouse` | The ClickHouse data source holding your spans |
| Traces table | `otel_traces` | Table of OpenTelemetry spans. Qualify as `database.table` if the data source's default database is not the right one |

The defaults match the bundled demo stack, so `make up` needs no configuration.
Saving reloads the page, because the app reads these settings once on load.

## Pages

| Page     | Path                                          | What it does                                                                                                             |
| -------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Event Deltas | `/a/jordo-eventdeltas-app/explorer`       | Latency heatmap in latency or errors mode, box selection, and attribute comparison of the selection against the baseline |
| Trace    | `/a/jordo-eventdeltas-app/trace/:traceId` | Span waterfall for one trace, with error insights                                                                        |

## Usage

1. Open **Event Deltas** and pick a time range.
2. Switch between **Latency** and **Errors** mode.
3. Drag a box around a band or blob that looks wrong.
4. Read the attribute comparison: attributes that are far more common inside the
   selection than outside it are ranked first.
5. Open a representative trace to see the span waterfall behind the pattern.

Selections travel on Grafana's app event bus (`event-deltas-selection`), so
the Event Deltas and Timeseries Selection panels can drive the same
comparison from an ordinary dashboard.

## Installation

Download the zip from the [releases page](https://github.com/jordan-simonovski/event-deltas/releases)
and unzip it into Grafana's plugin directory. Until the plugin is signed, allow
it to load:

```
GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=jordo-eventdeltas-app
```

## Development

From the repository root:

```bash
npm ci
npm run build --workspace=plugins/heatmap-app
```

`make up` starts Grafana, ClickHouse, an OpenTelemetry Collector and a synthetic
trace generator that emits eight labelled failure scenarios, so there is always
something to find in the heatmap.

## License

Apache-2.0. See [LICENSE](https://github.com/jordan-simonovski/event-deltas/blob/main/plugins/heatmap-app/LICENSE).
