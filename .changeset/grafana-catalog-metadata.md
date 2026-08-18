---
'heatmap-panel': minor
'timeseries-selection-panel': minor
'heatmap-app': minor
'slo-app': minor
---

Prepare the plugins for Grafana catalog submission: real author, catalog links
and screenshots in plugin.json, a proper README per plugin, and
`grafanaDependency` raised
to `>=12.0.0` to match the `@grafana/*` 12.3 dependencies the plugins are
actually built and tested against.
