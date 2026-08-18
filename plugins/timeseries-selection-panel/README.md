# Timeseries Selection

A timeseries line chart you can brush. Drag horizontally to select a time range,
and the panel publishes that selection on Grafana's app event bus so another
panel can compare the selected window against the rest of the series.

## Requirements

- Grafana 12.0 or later.
- A query returning a time field and a numeric value field.

## Usage

Add the panel to a dashboard, then drag across it to select a window. Right
click the selection for **Analyse Selection** (publishes the selection) or
**Zoom to time range** (moves the dashboard time range). Selections are emitted
as `heatmap-bubbles-selection` events, the same contract the Heatmap Bubbles
panel and app use.

## Options

| Option          | Default   | Description                        |
| --------------- | --------- | ---------------------------------- |
| Line color      | `#4285f4` | Series line color                  |
| Fill opacity    | 15        | Area fill under the line, 0-100    |
| Threshold value | none      | Optional horizontal threshold line |
| Threshold color | `#e53935` | Color of the threshold line        |
| Y-axis label    | `Value`   | Axis label                         |

## Installation

Download the zip from the [releases page](https://github.com/jordan-simonovski/heatmap-investigation/releases)
and unzip it into Grafana's plugin directory. Until the plugin is signed, allow
it to load:

```
GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=jordo-timeseries-selection-panel
```

## Development

From the repository root:

```bash
npm ci
npm run build --workspace=plugins/timeseries-selection-panel
```

## License

Apache-2.0. See [LICENSE](./LICENSE).
