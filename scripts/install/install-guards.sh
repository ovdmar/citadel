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
