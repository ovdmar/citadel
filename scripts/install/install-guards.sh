#!/usr/bin/env bash
# Shared guard helpers for scripts/install-systemd.sh and scripts/install/upgrade.sh.
# Source, do not exec. All functions return non-zero (and print to stderr) on
# refusal; callers must `set -e` so refusals propagate.
#
# Test fixtures point CITADEL_SERVICE_UNIT at a fake unit file under a tmp
# directory; production code reads the real `~/.config/systemd/user/citadel.service`.

# Refuse if the given directory is not a Citadel checkout (no apps/daemon).
citadel_require_checkout() {
  local root="$1"
  if [[ ! -d "$root/apps/daemon" ]]; then
    echo "✗ $root does not look like a Citadel checkout (missing apps/daemon)" >&2
    return 2
  fi
}

# Resolve the path of the installed citadel.service unit. Test fixtures
# override via CITADEL_SERVICE_UNIT; production reads ~/.config/systemd/user.
citadel_service_unit_path() {
  if [[ -n "${CITADEL_SERVICE_UNIT:-}" ]]; then
    printf '%s' "$CITADEL_SERVICE_UNIT"
    return
  fi
  printf '%s/systemd/user/citadel.service' "${XDG_CONFIG_HOME:-$HOME/.config}"
}

# Refuse if the installed unit's WorkingDirectory= line points elsewhere.
# If no unit file exists yet, this is a first install — pass through.
citadel_require_working_directory_match() {
  local root="$1"
  local unit
  unit="$(citadel_service_unit_path)"
  if [[ ! -r "$unit" ]]; then
    # First-time install — nothing to compare against.
    return 0
  fi
  local installed
  installed=$(grep -E '^WorkingDirectory=' "$unit" | head -1 | cut -d= -f2-)
  if [[ -z "$installed" ]]; then
    # Malformed unit; let the install script overwrite it.
    return 0
  fi
  if [[ "$installed" != "$root" ]]; then
    echo "✗ WorkingDirectory= mismatch: installed unit points at" >&2
    echo "    $installed" >&2
    echo "  but this script is running from" >&2
    echo "    $root" >&2
    echo "  Run from the installed checkout, or pass CITADEL_INSTALL_ROOT explicitly." >&2
    return 3
  fi
}

# Refuse a REF that doesn't match the annotated-tag semver shape.
citadel_require_valid_ref_shape() {
  local ref="$1"
  if [[ ! "$ref" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "✗ REF must match the annotated-tag pattern v<major>.<minor>.<patch>" >&2
    echo "  got: $ref" >&2
    return 4
  fi
}

citadel_is_release_tag_ref() {
  local ref="$1"
  [[ "$ref" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

citadel_require_valid_install_ref_shape() {
  local ref="$1"
  if [[ "$ref" == "main" ]]; then
    return 0
  fi
  if citadel_is_release_tag_ref "$ref"; then
    return 0
  fi
  echo "✗ REF must be either main or an annotated release tag v<major>.<minor>.<patch>" >&2
  echo "  got: $ref" >&2
  return 4
}

# Refuse a REF that doesn't resolve to an annotated tag in the local repo.
# Pre-condition: $1 = REF (already validated by citadel_require_valid_ref_shape).
citadel_require_annotated_tag() {
  local root="$1"
  local ref="$2"
  local kind
  kind=$(git -C "$root" cat-file -t "$ref" 2>/dev/null || true)
  if [[ "$kind" != "tag" ]]; then
    echo "✗ $ref is not an annotated tag in this repo (cat-file kind: ${kind:-not found})" >&2
    echo "  Lightweight tags, branches, and SHAs are not valid pin targets." >&2
    return 5
  fi
}

# Refuse to switch refs when the working tree has uncommitted changes.
citadel_require_clean_tree() {
  local root="$1"
  local porcelain
  porcelain=$(git -C "$root" status --porcelain 2>/dev/null || true)
  if [[ -n "$porcelain" ]]; then
    echo "✗ refusing to pin a REF: working tree is dirty" >&2
    echo "  uncommitted/untracked paths:" >&2
    echo "$porcelain" | sed 's/^/    /' >&2
    return 6
  fi
}

citadel_latest_origin_release_ref() {
  local root="$1"
  local remote_tags
  if ! remote_tags=$(git -C "$root" ls-remote --tags origin 'refs/tags/v*' 2>&1); then
    echo "✗ unable to query origin for release tags" >&2
    echo "$remote_tags" | sed 's/^/  /' >&2
    echo "  Default install/upgrade requires network access to origin; pass REF=main or REF=vX.Y.Z explicitly." >&2
    return 7
  fi

  local latest
  latest=$(
    printf '%s\n' "$remote_tags" \
      | awk '$2 ~ /^refs\/tags\/v[0-9]+\.[0-9]+\.[0-9]+\^\{\}$/ { ref=$2; sub(/^refs\/tags\//, "", ref); sub(/\^\{\}$/, "", ref); print ref }' \
      | sort -V \
      | tail -n 1
  )
  if [[ -z "$latest" ]]; then
    echo "✗ origin has no annotated release tags shaped v<major>.<minor>.<patch>" >&2
    echo "  Lightweight, malformed, and prerelease tags are ignored." >&2
    return 7
  fi
  printf '%s\n' "$latest"
}

citadel_fetch_origin_main() {
  local root="$1"
  if ! git -C "$root" fetch --quiet origin main; then
    echo "✗ unable to fetch origin/main" >&2
    return 8
  fi
}

citadel_fetch_origin_annotated_tag() {
  local root="$1"
  local ref="$2"
  local remote_tag
  if ! remote_tag=$(git -C "$root" ls-remote --tags origin "refs/tags/$ref" "refs/tags/$ref^{}" 2>&1); then
    echo "⚠ unable to query origin for $ref; will try local annotated tag fallback" >&2
    echo "$remote_tag" | sed 's/^/  /' >&2
    return 20
  fi
  if ! printf '%s\n' "$remote_tag" | awk -v ref="refs/tags/$ref^{}" '$2 == ref { found=1 } END { exit found ? 0 : 1 }'; then
    echo "✗ origin tag $ref is missing or is not annotated" >&2
    echo "  Lightweight tags, branches, and SHAs are not valid install targets." >&2
    return 5
  fi
  if ! git -C "$root" fetch --quiet --force origin "refs/tags/$ref:refs/tags/$ref"; then
    echo "✗ unable to fetch annotated tag $ref from origin" >&2
    return 8
  fi
}
