---
'heatmap-app': minor
'slo-app': minor
---

Make Event Deltas statistically sound.

The heatmap sampled with `ORDER BY Timestamp LIMIT 10000`, which returns the
*oldest* 10k spans rather than a sample. Measured on the demo stack, that was
54 seconds of a 900-second window — 6% of the data, all of it from the opening
of the range, and the comparison inherited the bias through the selected trace
IDs. Sampling is now `ORDER BY cityHash64(TraceId)`, which covers the whole
window at the same row count and stays stable across refreshes. Sample size is
tunable in the app via a new "Sample size" control (1k-50k, default 10k).

The comparison itself was up to 102 queries per selection — two per attribute,
each computing percentages over its own truncated top-20 denominator. It is now
one query whose group totals come from a window function evaluated before the
per-attribute limit, so percentages use real denominators.

Ranking is now confidence-adjusted: the lower bound of the 95% Agresti-Caffo
interval on the difference in proportions, so a value seen three times can no
longer outrank one seen nine hundred times. Cards still display the observed
difference; only the ordering and the "is this signal at all" decision use the
adjusted score. Values below five occurrences and identifier-like attributes
(user.id, db.statement) are dropped.

Direction is unchanged: a value is still only signal when it is
over-represented in the selection.
