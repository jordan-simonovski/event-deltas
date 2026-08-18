#!/usr/bin/env bash
# Run Grafana's plugin validator over each built plugin.
#
# This is the same check the catalog runs on submission. It rejected our first
# attempt over a stub LICENSE file and relative README links, neither of which
# any other gate here looks at.
#
# Expects `npm run build` to have run. Needs Go on PATH the first time, to
# install the validator.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

PLUGINS=(
  "heatmap-panel"
  "timeseries-selection-panel"
  "heatmap-app"
  "slo-app"
)

VALIDATOR="${PLUGIN_VALIDATOR_BIN:-}"
if [[ -z "$VALIDATOR" ]]; then
  if command -v plugincheck2 >/dev/null 2>&1; then
    VALIDATOR="$(command -v plugincheck2)"
  else
    echo "Installing plugincheck2..."
    GOBIN="$WORK_DIR/bin" go install github.com/grafana/plugin-validator/pkg/cmd/plugincheck2@latest
    VALIDATOR="$WORK_DIR/bin/plugincheck2"
  fi
fi

# The archive is unsigned until Grafana approves the plugin and assigns it a
# signature level, so that analyzer would fail every run before publication.
cat >"$WORK_DIR/config.yaml" <<'EOF'
global:
  enabled: true
analyzers:
  signature:
    enabled: false
EOF

FAILED=()

for PLUGIN in "${PLUGINS[@]}"; do
  DIST="$ROOT_DIR/plugins/$PLUGIN/dist"
  if [[ ! -f "$DIST/plugin.json" ]]; then
    echo "Error: $PLUGIN has no dist/plugin.json — run 'npm run build' first." >&2
    exit 1
  fi

  PLUGIN_ID=$(node -e "process.stdout.write(require('$DIST/plugin.json').id)")

  # The validator reads an archive, and expects the plugin id as the root directory.
  cp -r "$DIST" "$WORK_DIR/$PLUGIN_ID"
  (cd "$WORK_DIR" && zip -qr "$PLUGIN_ID.zip" "$PLUGIN_ID")

  echo ""
  echo "==> $PLUGIN_ID"
  if ! "$VALIDATOR" -config "$WORK_DIR/config.yaml" "$WORK_DIR/$PLUGIN_ID.zip"; then
    FAILED+=("$PLUGIN_ID")
  fi
done

echo ""
if [[ ${#FAILED[@]} -gt 0 ]]; then
  echo "Plugin validation failed: ${FAILED[*]}" >&2
  exit 1
fi

echo "All plugins passed validation."
