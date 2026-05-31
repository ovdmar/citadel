#!/usr/bin/env bash
# Citadel upgrade verb. Updates the long-term systemd-supervised checkout to
# a new version of Citadel.
#
# Usage:
#   bash scripts/install/upgrade.sh                 # latest annotated origin release, reinstall
#   bash scripts/install/upgrade.sh REF=main        # latest origin/main, reinstall
#   bash scripts/install/upgrade.sh REF=v0.3.0      # exact annotated release tag, reinstall
#   CITADEL_INSTALL_REF=v0.3.0 bash scripts/install/upgrade.sh
#
# Refusals (no state mutated before each):
#   - $(pwd) is not a Citadel checkout                  → exit 2
#   - WorkingDirectory= of installed unit ≠ $(pwd)      → exit 3
#   - REF is neither main nor ^v<x>.<y>.<z>$            → exit 4
#   - REF is not an annotated tag in this repo          → exit 5
#   - checkout target would change with a dirty tree    → exit 6
#   - default latest-release resolution fails           → exit 7

set -euo pipefail

# Resolve the script's own directory so we source the guard lib regardless
# of cwd, then chdir into the install root for everything else.
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
# shellcheck source=./install-guards.sh
source "$SCRIPT_DIR/install-guards.sh"

ROOT="${CITADEL_INSTALL_ROOT:-$(pwd)}"
REF="${CITADEL_INSTALL_REF:-}"

# Parse `REF=...` positional arg form for the Makefile.
for arg in "$@"; do
  case "$arg" in
    REF=*) REF="${arg#REF=}" ;;
    *) echo "✗ unknown argument: $arg (expected REF=v<x.y.z>)" >&2; exit 1 ;;
  esac
done

citadel_require_checkout "$ROOT"
citadel_require_working_directory_match "$ROOT"

if [[ -n "$REF" ]]; then
  citadel_require_valid_install_ref_shape "$REF"
else
  REF="$(citadel_latest_origin_release_ref "$ROOT")"
fi
citadel_require_clean_tree "$ROOT"

if [[ "$REF" == "main" ]]; then
  echo "→ Installing from origin/main"
  citadel_fetch_origin_main "$ROOT"
  git -C "$ROOT" checkout --quiet --detach origin/main
else
  echo "→ Installing release $REF"
  if citadel_fetch_origin_annotated_tag "$ROOT" "$REF"; then
    :
  else
    fetch_status=$?
    if [[ "$fetch_status" -eq 20 ]]; then
      citadel_require_annotated_tag "$ROOT" "$REF"
      echo "→ Using local annotated tag $REF"
    else
      exit "$fetch_status"
    fi
  fi
  git -C "$ROOT" checkout --quiet "$REF"
fi

# Test mode stops here so the test suite never actually invokes pnpm or systemctl.
if [[ -n "${CITADEL_UPGRADE_TEST:-}" ]]; then
  echo "→ CITADEL_UPGRADE_TEST set; stopping before pnpm + systemctl"
  exit 0
fi

echo "→ pnpm install --frozen-lockfile"
( cd "$ROOT" && pnpm install --frozen-lockfile )

echo "→ delegating to scripts/install-systemd.sh"
exec env -u CITADEL_INSTALL_REF bash "$ROOT/scripts/install-systemd.sh"
