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
| `jordo-timeseries-selection-panel` | yes | |
| `jordo-slo-app` | not yet | A reviewer cannot exercise it without the Go control plane running alongside Grafana |

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

`img/demo.gif` on the Event Deltas app, `img/selection.png` and `img/panel.png`
on the heatmap panel, `img/demo.gif` on the timeseries panel. The SLO app needs
one if it is ever submitted. Drop PNGs into `plugins/<plugin>/src/img/` and list
them:

```json
"screenshots": [{ "name": "Explorer", "path": "img/screenshot-explorer.png" }]
```

Grafana renders these on the plugin page, so use the demo stack (`make up`) and
capture the workflow, not an empty panel.

### 3. Do NOT sign the first release

Submit unsigned. A plugin that has never been through review has no signature
level, and `sign-plugin` answers HTTP 409 until it does:

> The Grafana team needs to review public plugins before you can sign them.
> — [Sign a plugin](https://grafana.com/developers/plugin-tools/publish-a-plugin/sign-a-plugin)

A team member assigns the signature level on approval. Only then does
`GRAFANA_SIGN_CATALOG=true` work, and it applies to the releases *after*
approval, not the one being submitted.

This is the same 409 the repo hit in July 2026 (commits `b5d517d`, `817129b`).
The conclusion then was that the IDs were not registered in the catalog, which
was correct; owning the `jordo` org slug does not change it. Registration
happens at approval, not at org creation. Leave `GRAFANA_SIGN_CATALOG` unset
until the catalog lists the plugin.

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
