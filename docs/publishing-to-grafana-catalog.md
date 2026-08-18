# Publishing to the Grafana plugin catalog

The four plugins already ship as GitHub releases. The catalog is a separate,
manual submission per plugin. This is what is done, and what still needs doing.

The catalog is the free listing. The Grafana Marketplace is the paid track with
its own review and terms — not relevant here, these are Apache-2.0.

## What we are submitting

Three of the four:

| Plugin | Submitting | Notes |
|---|---|---|
| `jordo-event-deltas-panel` | yes | |
| `jordo-event-deltas-app` | yes | |
| `jordo-timeseries-selection-panel` | yes | Going in without screenshots |
| `jordo-slo-app` | not yet | A reviewer cannot exercise it without the Go control plane running alongside Grafana |

The timeseries panel ships with an empty `info.screenshots`, so its catalog page
shows the logo and the README and nothing else. Grafana lists screenshots under
required metadata, so expect review to ask; one capture of a brush selection
with the context menu open is enough to close it out.

The SLO app is catalog-ready apart from screenshots and can be submitted later
without further work.

## Done in this repo

- Plugin metadata: real author, `links` (website, docs, license), `$schema` on
  all four manifests.
- `grafanaDependency: >=12.0.0`. The plugins depend on `@grafana/*` 12.3 and are
  only tested against Grafana 12.3, so the old `>=11.6.0` floor was a claim we
  could not back.
- A real README per plugin: requirements, data contract, options, install.
- `scripts/publish-plugins.sh` writes a `.sha1` next to the `.md5` (the
  submission form asks for SHA1) and supports community signing via
  `GRAFANA_SIGN_CATALOG=true`.
- The `jordo` Grafana Cloud org slug exists, so the plugin IDs are already in
  the required `<org-slug>-<name>-<type>` shape and no rename is needed.

## Still to do

### 1. Check the signing token belongs to the `jordo` org

The repo already has a `GRAFANA_ACCESS_POLICY_TOKEN` secret, but it dates from
March 2026 — created while catalog signing was still failing with HTTP 409
because no org owned the prefix. Confirm it was issued by the `jordo` org with
scope `plugins:write`, and rotate it if not: a token from the wrong org fails
the same way the old one did.

Order matters. Set the token first, then the variable — `GRAFANA_SIGN_CATALOG`
without a token makes the publish script exit rather than publish unsigned.

### 2. Screenshots (done)

`img/demo.gif` on the app, `img/selection.png` and `img/panel.png` on the
heatmap panel. The timeseries panel is going in deliberately without one; the
SLO app needs one if it is ever submitted. Drop PNGs into `plugins/<plugin>/src/img/` and list
them:

```json
"screenshots": [{ "name": "Explorer", "path": "img/screenshot-explorer.png" }]
```

Grafana renders these on the plugin page, so use the demo stack (`make up`) and
capture the workflow, not an empty panel.

### 3. Sign

Set the repo variable `GRAFANA_SIGN_CATALOG=true` and the next release produces
community-signed zips. An HTTP 409 still means the token's org does not own the
ID prefix — see step 1.

Signing a plugin the catalog has never seen is fine: the signature is what the
submission is reviewed against.

### 4. Validate

Run the [plugin validator](https://github.com/grafana/plugin-validator) against
each release zip before submitting. It catches most of what the automated half
of the review checks.

### 5. Submit

Grafana Cloud > **Org Settings > My Plugins > Submit New Plugin**, once per
plugin. You must be an org admin. The form wants:

| Field            | Value                                             |
| ---------------- | ------------------------------------------------- |
| URL              | the release zip asset URL                         |
| Source code URL  | this repository                                   |
| SHA1             | contents of the `.sha1` asset                     |
| Testing guidance | how to install, configure and exercise the plugin |

Two things reviewers will need spelled out:

- This is a monorepo. Tell them which directory the plugin lives in and give
  the build commands (`npm ci`, `npm run build --workspace=plugins/<plugin>`).
- The SLO Analysis App needs the Go control plane on `:8080`. Point them at
  `make up`, which brings up Grafana, ClickHouse, the control plane and a trace
  generator with demo SLOs seeded — that also satisfies the "provisioned test
  environment with sample data" they ask for.

Review is automated checks first, then a human who reads the code and installs
the plugin. Updates go through the same form via **Submit Update**.
