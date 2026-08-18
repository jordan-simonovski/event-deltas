---
'heatmap-panel': patch
'timeseries-selection-panel': patch
'heatmap-app': patch
'slo-app': patch
---

Fix the licence and README problems that failed automated catalog submission.

`timeseries-selection-panel` and `slo-app` shipped a LICENSE file containing
the single line "Apache License 2.0" rather than the licence, which the
validator could not parse. All four still had the Apache template's
`{yyyy} {name of copyright owner}` placeholder, and their READMEs linked the
licence relatively, which does not resolve on a catalog page.
