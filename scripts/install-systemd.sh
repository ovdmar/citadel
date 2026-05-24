#!/usr/bin/env bash
# Install or refresh the systemd --user unit `citadel.service` to supervise the
# Citadel daemon out of the *current checkout* (CITADEL_INSTALL_ROOT, default
# $(pwd)). Idempotent: overwrites the unit, daemon-reloads, builds, enables,
# and restarts.
#
# Defaults are auto-detected: TTYD_BIN via `command -v ttyd`, CITADEL_SHELL_BIN
# via /usr/bin/bash if present, OPENCLAW_ROOT via $HOME/.openclaw, etc. Pass
# overrides as env vars before invoking.

set -euo pipefail

ROOT="${CITADEL_INSTALL_ROOT:-$(pwd)}"
if [[ ! -d "$ROOT/apps/daemon" ]]; then
  echo "✗ $ROOT does not look like a Citadel checkout (missing apps/daemon)" >&2
  exit 2
fi

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/citadel.service"
mkdir -p "$UNIT_DIR"

NODE_BIN="${CITADEL_NODE_BIN:-$(command -v node || true)}"
if [[ -z "$NODE_BIN" ]]; then
  echo "✗ node not found in PATH (set CITADEL_NODE_BIN to override)" >&2
  exit 127
fi
TTYD_BIN="${TTYD_BIN:-$(command -v ttyd || true)}"
SHELL_BIN="${CITADEL_SHELL_BIN:-/usr/bin/bash}"
OPENCLAW_ROOT="${OPENCLAW_ROOT:-$HOME/.openclaw}"
CITADEL_CONFIG_PATH="${CITADEL_CONFIG:-$HOME/.local/share/citadel/citadel.config.json}"
SERVICE_PATH="${CITADEL_SERVICE_PATH:-/home/linuxbrew/.linuxbrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin}"

echo "→ Installing citadel.service → $ROOT"
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
  echo "Environment=CITADEL_CONFIG=$CITADEL_CONFIG_PATH"
  echo "Environment=OPENCLAW_ROOT=$OPENCLAW_ROOT"
  echo "Environment=CITADEL_OPENCLAW_STATUS_TIMEOUT_MS=15000"
  echo "Environment=CITADEL_SHELL_BIN=$SHELL_BIN"
  [[ -n "$TTYD_BIN" ]] && echo "Environment=TTYD_BIN=$TTYD_BIN"
  echo "Environment=PATH=$SERVICE_PATH"
  echo "ExecStart=$NODE_BIN $ROOT/apps/daemon/dist/index.js"
  echo "Restart=always"
  echo "RestartSec=3"
  echo ""
  echo "[Install]"
  echo "WantedBy=default.target"
} > "$UNIT_PATH"

echo "→ daemon-reload"
systemctl --user daemon-reload

echo "→ pnpm build (so the supervised process has a fresh dist)"
( cd "$ROOT" && pnpm build )

echo "→ enable --now + restart citadel.service"
systemctl --user enable --now citadel.service
systemctl --user restart citadel.service
sleep 0.6

if systemctl --user is-active --quiet citadel.service; then
  echo "✓ citadel.service installed and running"
  systemctl --user status citadel.service --no-pager | head -8
else
  echo "✗ citadel.service failed to start"
  systemctl --user status citadel.service --no-pager | head -20
  exit 1
fi
