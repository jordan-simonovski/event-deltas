# Publishing to the Grafana plugin catalog

The four plugins already ship as GitHub releases. The catalog is a separate,
manual submission per plugin. This is what is done, and what still needs doing.

The catalog is the free listing. The Grafana Marketplace is the paid track with
its own review and terms — not relevant here, these are Apache-2.0.

## Submission order

Submit the two panels and the Event Deltas App first. The SLO Analysis App
is deferred: a reviewer cannot exercise it without the Go control plane running
alongside Grafana, which makes it the slowest of the four to get through review.
Its metadata and README are catalog-ready either way.

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

## Still to do

### 1. Own the `jordo` prefix

A plugin ID must be `<grafana-cloud-org-slug>-<name>-<type>`, and the Access
Policy token used to sign must belong to that org. Either register a Grafana
Cloud org with the slug `jordo`, or rename all four IDs — a rename touches the
docker-compose allowlist, `constants.ts`, provisioning, docs, and breaks any
existing install, so decide before the first catalog release.

### 2. Screenshots

`info.screenshots` is empty in all four manifests. The catalog page needs at
least one image per plugin (the SLO Analysis App can wait, see submission order
above). Drop PNGs into `plugins/<plugin>/src/img/` and list
them:

```json
"screenshots": [{ "name": "Explorer", "path": "img/screenshot-explorer.png" }]
```

Grafana renders these on the plugin page, so use the demo stack (`make up`) and
capture the workflow, not an empty panel.

### 3. Sign

Create an Access Policy token in Grafana Cloud (**My Account > Security >
Access Policies**, scope `plugins:write`), store it as the
`GRAFANA_ACCESS_POLICY_TOKEN` repo secret, and set the repo variable
`GRAFANA_SIGN_CATALOG=true`. The next release will produce signed zips. An
HTTP 409 means the token's org does not own the ID prefix — see step 1.

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
