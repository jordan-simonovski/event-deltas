# SLO Analysis App

SLO monitoring that ends in a root cause rather than a red tile. Each SLO page
shows burn rate and error budget, then drops you straight into a latency heatmap
of the traffic that burned it, with attribute comparison to show what the
burning requests have in common.

## Requirements

- Grafana 12.0 or later.
- The [SLO control plane](https://github.com/jordan-simonovski/event-deltas/tree/main/services/slo-control-plane),
  a standalone Go service that stores SLO definitions and evaluates burn rate.
  Set its base URL in the app's configuration page (default
  `http://localhost:8080`).
- The [ClickHouse data source](https://grafana.com/grafana/plugins/grafana-clickhouse-datasource/),
  provisioned with the UID `clickhouse`, holding OpenTelemetry trace data in an
  `otel_traces` table.
- Optional: the Event Deltas App (`jordo-eventdeltas-app`) for trace
  drilldown from an investigation.

## Pages

| Page           | Path                                      | What it does                                             |
| -------------- | ----------------------------------------- | -------------------------------------------------------- |
| Investigations | `/a/jordo-slo-app/investigations` | SLOs currently burning, ordered by urgency               |
| SLO Catalog    | `/a/jordo-slo-app/catalog`        | Every SLO with target, window and current compliance     |
| Ownership      | `/a/jordo-slo-app/ownership`      | Teams and the services they own                          |
| Operations     | `/a/jordo-slo-app/operations`     | Control plane state: burn events and managed alert rules |

Detail routes exist for a single team, service, or SLO.

## Configuration

Go to **Administration > Plugins > SLO Analysis App > Configuration** and set
**SLO Control Plane URL**. The app talks to that API over the browser, so the
URL must be reachable from the user's browser, not just from the Grafana server.

## Installation

Download the zip from the [releases page](https://github.com/jordan-simonovski/event-deltas/releases)
and unzip it into Grafana's plugin directory. Until the plugin is signed, allow
it to load:

```
GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=jordo-slo-app
```

## Development

From the repository root:

```bash
npm ci
npm run build --workspace=plugins/slo-app
```

`make up` starts Grafana, ClickHouse, the control plane, its burn evaluator, and
a trace generator with demo SLOs already seeded.

## License

Apache-2.0. See [LICENSE](./LICENSE).
