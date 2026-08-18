---
'heatmap-app': patch
'slo-app': patch
---

Declare the panel plugins the apps embed. Both render panels by plugin ID —
Event Deltas in the app's explorer, Event Deltas and Timeseries Selection in
the SLO drilldown — but shipped with an empty `dependencies.plugins`, so
installing an app on its own left a missing-panel box where the main
visualisation should be.
