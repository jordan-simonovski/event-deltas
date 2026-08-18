#!/usr/bin/env bash
# Build, sign, zip, and publish all Grafana plugins as GitHub releases.
# Idempotent: skips any plugin version that already has a GitHub release tag.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PLUGINS=(
  "heatmap-panel"
  "timeseries-selection-panel"
  "heatmap-app"
  "slo-app"
)

write_md5_file() {
  local input_file="$1"
  local output_file="$2"

  if command -v md5sum >/dev/null 2>&1; then
    md5sum "$input_file" | awk '{print $1}' >"$output_file"
    return
  fi

  if command -v md5 >/dev/null 2>&1; then
    md5 -q "$input_file" >"$output_file"
    return
  fi

  echo "Error: neither md5sum nor md5 is available to generate checksums." >&2
  exit 1
}

# The Grafana catalog submission form asks for the SHA1 of the archive.
write_sha1_file() {
  local input_file="$1"
  local output_file="$2"

  if command -v sha1sum >/dev/null 2>&1; then
    sha1sum "$input_file" | awk '{print $1}' >"$output_file"
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 1 "$input_file" | awk '{print $1}' >"$output_file"
    return
  fi

  echo "Error: neither sha1sum nor shasum is available to generate checksums." >&2
  exit 1
}

# Signing mode. Two mutually exclusive opt-ins, both off by default:
#
#   GRAFANA_SIGN_ROOT_URLS=<url,url>  private signature, scoped to those Grafana
#                                     instances. Works for any plugin ID.
#   GRAFANA_SIGN_CATALOG=true         community signature for the Grafana plugin
#                                     catalog. Only works once the plugin ID
#                                     prefix (jordo-) is a Grafana Cloud org slug
#                                     we own and the token belongs to that org —
#                                     otherwise Grafana answers HTTP 409.
#
# Neither set means unsigned zips, which is how the demo stack loads them
# (GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS in docker-compose).
SIGN_MODE="none"
if [[ -n "${GRAFANA_SIGN_ROOT_URLS:-}" && "${GRAFANA_SIGN_CATALOG:-}" == "true" ]]; then
  echo "Error: set either GRAFANA_SIGN_ROOT_URLS (private) or GRAFANA_SIGN_CATALOG (community), not both." >&2
  exit 1
elif [[ -n "${GRAFANA_SIGN_ROOT_URLS:-}" ]]; then
  SIGN_MODE="private"
elif [[ "${GRAFANA_SIGN_CATALOG:-}" == "true" ]]; then
  SIGN_MODE="catalog"
fi

if [[ "$SIGN_MODE" != "none" && -z "${GRAFANA_ACCESS_POLICY_TOKEN:-}" ]]; then
  echo "Error: signing is enabled but GRAFANA_ACCESS_POLICY_TOKEN is not set." >&2
  exit 1
fi

if [[ "$SIGN_MODE" == "none" ]]; then
  echo "No signing mode set — publishing UNSIGNED plugin zips." >&2
  echo "Grafana must allowlist them via GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS." >&2
fi

if [[ -z "${GITHUB_REPOSITORY:-}" ]]; then
  echo "Error: GITHUB_REPOSITORY is not set." >&2
  exit 1
fi

# Build all plugins
echo "Building all plugins..."
npm run build --prefix "$ROOT_DIR"

for PLUGIN in "${PLUGINS[@]}"; do
  PLUGIN_DIR="$ROOT_DIR/plugins/$PLUGIN"
  echo ""
  echo "==> Processing $PLUGIN..."

  # Read plugin ID from the built dist/plugin.json
  PLUGIN_ID=$(node -e "process.stdout.write(require('${PLUGIN_DIR}/dist/plugin.json').id)")

  # Read version from package.json (updated by changeset version)
  VERSION=$(node -e "process.stdout.write(require('${PLUGIN_DIR}/package.json').version)")

  TAG="${PLUGIN_ID}-v${VERSION}"

  # Skip if this release already exists (idempotent)
  if gh release view "$TAG" --repo "$GITHUB_REPOSITORY" &>/dev/null; then
    echo "    Release $TAG already exists — skipping."
    continue
  fi

  if [[ "$SIGN_MODE" != "none" ]]; then
    if [[ "$SIGN_MODE" == "private" ]]; then
      echo "    Signing plugin (private, rootUrls: ${GRAFANA_SIGN_ROOT_URLS})..."
      SIGN_ARGS=(--rootUrls "$GRAFANA_SIGN_ROOT_URLS")
    else
      echo "    Signing plugin (community, Grafana catalog)..."
      SIGN_ARGS=()
    fi
    if SIGN_OUTPUT=$(cd "$PLUGIN_DIR" && GRAFANA_ACCESS_POLICY_TOKEN="$GRAFANA_ACCESS_POLICY_TOKEN" \
        npm run sign -- ${SIGN_ARGS[@]+"${SIGN_ARGS[@]}"} 2>&1); then
      printf '%s\n' "$SIGN_OUTPUT"
    else
      SIGN_EXIT=$?
      printf '%s\n' "$SIGN_OUTPUT"
      if [[ "$SIGN_OUTPUT" == *"status code 409"* ]]; then
        echo "    Error: Grafana rejected the signing request for ${PLUGIN_ID} (HTTP 409)." >&2
        echo "    Likely causes: plugin ID prefix does not match the Grafana Cloud org slug" >&2
        echo "    that issued GRAFANA_ACCESS_POLICY_TOKEN, or the ID is owned by another org." >&2
      fi
      exit "$SIGN_EXIT"
    fi
  else
    echo "    Skipping signing (unsigned publish)."
  fi

  # Package: rename dist → plugin-id, zip, restore
  echo "    Creating zip archive ${PLUGIN_ID}-${VERSION}.zip..."
  cd "$PLUGIN_DIR"
  cp -r dist "$PLUGIN_ID"
  zip -r "${PLUGIN_ID}-${VERSION}.zip" "$PLUGIN_ID"
  rm -rf "$PLUGIN_ID"
  cd "$ROOT_DIR"

  # Extract release notes for this version from CHANGELOG.md
  NOTES=""
  if [[ -f "$PLUGIN_DIR/CHANGELOG.md" ]]; then
    NOTES=$(awk \
      "/^## ${VERSION}[[:space:]]*$/{found=1; next} found && /^## /{exit} found{print}" \
      "$PLUGIN_DIR/CHANGELOG.md" \
      | sed '/^[[:space:]]*$/d' \
      || true)
  fi
  if [[ -z "$NOTES" ]]; then
    NOTES="Release ${PLUGIN_ID} v${VERSION}"
  fi

  ZIP_PATH="$PLUGIN_DIR/${PLUGIN_ID}-${VERSION}.zip"
  MD5_PATH="$PLUGIN_DIR/${PLUGIN_ID}-${VERSION}.zip.md5"
  SHA1_PATH="$PLUGIN_DIR/${PLUGIN_ID}-${VERSION}.zip.sha1"

  echo "    Generating checksums (.md5, .sha1)..."
  write_md5_file "$ZIP_PATH" "$MD5_PATH"
  write_sha1_file "$ZIP_PATH" "$SHA1_PATH"

  # Create the GitHub release and attach the zip + checksums
  echo "    Creating GitHub release $TAG..."
  gh release create "$TAG" \
    --repo "$GITHUB_REPOSITORY" \
    --title "${PLUGIN_ID} v${VERSION}" \
    --notes "$NOTES" \
    "$ZIP_PATH" \
    "$MD5_PATH" \
    "$SHA1_PATH"

  # Clean up release assets from the plugin directory
  rm -f "$ZIP_PATH" "$MD5_PATH" "$SHA1_PATH"

  echo "    Released $TAG"
done

echo ""
echo "All plugins processed."
