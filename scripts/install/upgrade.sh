#!/usr/bin/env bash
# Citadel upgrade verb. Updates the long-term systemd-supervised checkout to
# a new version of Citadel.
#
# Usage:
#   bash scripts/install/upgrade.sh                 # ff-pull current branch, reinstall
#   bash scripts/install/upgrade.sh REF=v0.3.0      # validate + checkout tag, reinstall
#   CITADEL_INSTALL_REF=v0.3.0 bash scripts/install/upgrade.sh
#
# Refusals (no state mutated before each):
#   - $(pwd) is not a Citadel checkout                  → exit 2
#   - WorkingDirectory= of installed unit ≠ $(pwd)      → exit 3
#   - REF does not match ^v<x>.<y>.<z>$                 → exit 4
#   - REF is not an annotated tag in this repo          → exit 5
#   - REF given but working tree is dirty               → exit 6

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
  citadel_require_valid_ref_shape "$REF"
  citadel_require_annotated_tag "$ROOT" "$REF"
  citadel_require_clean_tree "$ROOT"

  echo "→ Pinning to ref $REF"
  git -C "$ROOT" fetch --tags --quiet
  git -C "$ROOT" checkout --quiet "$REF"
else
  echo "→ Updating current branch (fast-forward only)"
  git -C "$ROOT" pull --ff-only
fi

# Test mode stops here so the test suite never actually invokes pnpm or systemctl.
if [[ -n "${CITADEL_UPGRADE_TEST:-}" ]]; then
  echo "→ CITADEL_UPGRADE_TEST set; stopping before pnpm + systemctl"
  exit 0
fi

echo "→ pnpm install --frozen-lockfile"
( cd "$ROOT" && pnpm install --frozen-lockfile )

echo "→ delegating to scripts/install-systemd.sh"
exec bash "$ROOT/scripts/install-systemd.sh"
