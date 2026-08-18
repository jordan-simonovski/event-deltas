---
'heatmap-app': minor
---

Make the data source and traces table configurable.

The app hardcoded a data source UID of `clickhouse` and a table of
`otel_traces`, so it only worked against a Grafana provisioned exactly like the
bundled demo stack. Both are now settings on the app's configuration page, with
those same values as defaults — an existing install behaves identically without
being touched.

Replaces the scaffold configuration page, which asked for an API URL and API key
the app never read.
