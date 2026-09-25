#!/usr/bin/env bash
# Install or refresh the systemd --user unit `citadel.service` to supervise
# the Citadel daemon out of the current checkout (CITADEL_INSTALL_ROOT,
# default $(pwd)). Idempotent.
#
# Citadel uses one tmux server per workspace. Those servers are created on
# demand via socket names derived from CITADEL_TMUX_SOCKET and are not
# supervised by a separate citadel-tmux.service unit.
#
# Defaults auto-detected; override via env (CITADEL_NODE_BIN,
# CITADEL_SHELL_BIN, OPENCLAW_ROOT, CITADEL_CONFIG, CITADEL_TMUX_SOCKET, etc.).
# Release/main ref resolution is handled by scripts/install/upgrade.sh, which
# is what the Makefile install and upgrade targets call before this script.

set -euo pipefail

ROOT="${CITADEL_INSTALL_ROOT:-$(pwd)}"

# Shared refusal guards live in scripts/install/install-guards.sh so the
# upgrade verb can apply the exact same checks before delegating here.
# shellcheck source=./install/install-guards.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/install/install-guards.sh"

citadel_require_checkout "$ROOT"
citadel_require_working_directory_match "$ROOT"

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/citadel.service"
mkdir -p "$UNIT_DIR"

TMUX_SOCK="${CITADEL_TMUX_SOCKET:-citadel}"

NODE_BIN="${CITADEL_NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
  echo "✗ node not found in PATH (set CITADEL_NODE_BIN to override)" >&2
  exit 127
fi
SHELL_BIN="${CITADEL_SHELL_BIN:-/usr/bin/bash}"
OPENCLAW_ROOT="${OPENCLAW_ROOT:-$HOME/.openclaw}"
CITADEL_CONFIG_PATH="${CITADEL_CONFIG:-$HOME/.local/share/citadel/citadel.config.json}"
SERVICE_PATH="${CITADEL_SERVICE_PATH:-/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"

echo "→ Writing citadel.service → $ROOT"
CITADEL_UNIT_TMP="$(mktemp)"
{
  echo "[Unit]"
  echo "Description=Citadel local operator cockpit"
  echo "After=network-online.target"
  echo "Wants=network-online.target"
  echo ""
  echo "[Service]"
  echo "Type=simple"
  echo "WorkingDirectory=$ROOT"
  echo "Environment=NODE_ENV=production"
  # Pin the long-term port. The daemon refuses to bind 4010 from a checkout
  # without an explicit CITADEL_PORT, to keep ad-hoc invocations from
  # clobbering this service.
  echo "Environment=CITADEL_PORT=4010"
  echo "Environment=CITADEL_AUTOMATED_GH=1"
  echo "Environment=CITADEL_CONFIG=$CITADEL_CONFIG_PATH"
  echo "Environment=OPENCLAW_ROOT=$OPENCLAW_ROOT"
  echo "Environment=CITADEL_OPENCLAW_STATUS_TIMEOUT_MS=15000"
  echo "Environment=CITADEL_SHELL_BIN=$SHELL_BIN"
  # Base socket prefix; workspace sessions use <base>-ws-<workspaceId>.
  echo "Environment=CITADEL_TMUX_SOCKET=$TMUX_SOCK"
  echo "Environment=PATH=$SERVICE_PATH"
  echo "ExecStart=$NODE_BIN $ROOT/apps/daemon/dist/index.js"
  echo "Restart=always"
  echo "RestartSec=3"
  # Workspace tmux servers are child processes of the daemon's tmux commands
  # and must survive daemon restarts; terminal reaper cleans up stale clients.
  echo "KillMode=process"
  echo ""
  echo "[Install]"
  echo "WantedBy=default.target"
} > "$CITADEL_UNIT_TMP"

CITADEL_UNIT_CHANGED=false
if ! cmp -s "$CITADEL_UNIT_TMP" "$UNIT_PATH" 2>/dev/null; then
  CITADEL_UNIT_CHANGED=true
  mv "$CITADEL_UNIT_TMP" "$UNIT_PATH"
  echo "  ↳ citadel.service content changed"
else
  rm -f "$CITADEL_UNIT_TMP"
  echo "  ↳ citadel.service unchanged"
fi

if $CITADEL_UNIT_CHANGED; then
  systemctl --user daemon-reload
fi

systemctl --user enable citadel.service >/dev/null 2>&1 || true
systemctl --user disable citadel-tmux.service >/dev/null 2>&1 || true

echo "→ pnpm build (so the supervised process has a fresh dist)"
( cd "$ROOT" && pnpm build )

echo "→ prepare PTY daemon handoff"
env CITADEL_INSTALL_ROOT="$ROOT" CITADEL_CONFIG="$CITADEL_CONFIG_PATH" "$NODE_BIN" "$ROOT/scripts/install/prepare-pty-daemon-upgrade.mjs"

echo "→ restart citadel.service"
systemctl --user restart citadel.service
sleep 0.6
if ! systemctl --user is-active --quiet citadel.service; then
  echo "✗ citadel.service failed to start"
  systemctl --user status citadel.service --no-pager | head -20
  exit 1
fi
echo "✓ citadel.service active"
systemctl --user status citadel.service --no-pager | head -8 || true

echo "→ make doctor"
( cd "$ROOT" && make doctor )
