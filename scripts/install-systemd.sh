#!/usr/bin/env bash
# Install or refresh the systemd --user units `citadel-tmux.service` and
# `citadel.service` to supervise the Citadel daemon out of the current
# checkout (CITADEL_INSTALL_ROOT, default $(pwd)). Idempotent.
#
# Layered lifecycle:
#   citadel-tmux.service  — long-lived tmux server. Survives daemon restarts.
#                           This script never restarts it: tmux is sacred,
#                           every live agent session lives inside it.
#                           To apply unit changes, run `make tmux-service`.
#   citadel.service       — the daemon. Always restarted by this script so the
#                           freshly-built dist/ is picked up.
#
# Defaults auto-detected; override via env (TTYD_BIN, CITADEL_NODE_BIN,
# CITADEL_SHELL_BIN, OPENCLAW_ROOT, CITADEL_CONFIG, CITADEL_TMUX_SOCKET, etc.).

set -euo pipefail

ROOT="${CITADEL_INSTALL_ROOT:-$(pwd)}"
if [[ ! -d "$ROOT/apps/daemon" ]]; then
  echo "✗ $ROOT does not look like a Citadel checkout (missing apps/daemon)" >&2
  exit 2
fi

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/citadel.service"
TMUX_UNIT_PATH="$UNIT_DIR/citadel-tmux.service"
mkdir -p "$UNIT_DIR"

TMUX_SOCK="${CITADEL_TMUX_SOCKET:-citadel}"
TMUX_BIN_PATH="${TMUX_BIN_PATH:-$(command -v tmux || echo /usr/bin/tmux)}"

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

echo "→ Writing citadel-tmux.service (tmux server, socket=$TMUX_SOCK)"
TMUX_UNIT_TMP="$(mktemp)"
{
  echo "[Unit]"
  echo "Description=Citadel tmux server (long-lived; survives citadel.service restarts)"
  echo ""
  echo "[Service]"
  # `tmux -L $SOCK -D` runs the server in the foreground (no daemonise) and
  # turns the exit-empty option off — the server stays up with zero sessions.
  # systemd tracks the actual server PID, so Restart=on-failure fires on real
  # tmux crashes.
  echo "Type=simple"
  echo "Environment=PATH=$SERVICE_PATH"
  echo "ExecStart=$TMUX_BIN_PATH -L $TMUX_SOCK -D"
  echo "Restart=on-failure"
  echo "RestartSec=2"
  echo ""
  echo "[Install]"
  echo "WantedBy=default.target"
} > "$TMUX_UNIT_TMP"

TMUX_UNIT_CHANGED=false
if ! cmp -s "$TMUX_UNIT_TMP" "$TMUX_UNIT_PATH" 2>/dev/null; then
  TMUX_UNIT_CHANGED=true
  mv "$TMUX_UNIT_TMP" "$TMUX_UNIT_PATH"
  echo "  ↳ citadel-tmux.service content changed (apply with: make tmux-service)"
else
  rm -f "$TMUX_UNIT_TMP"
  echo "  ↳ citadel-tmux.service unchanged"
fi

echo "→ Writing citadel.service → $ROOT"
CITADEL_UNIT_TMP="$(mktemp)"
{
  echo "[Unit]"
  echo "Description=Citadel local operator cockpit"
  echo "After=network-online.target citadel-tmux.service"
  echo "Wants=network-online.target citadel-tmux.service"
  echo ""
  echo "[Service]"
  echo "Type=simple"
  echo "WorkingDirectory=$ROOT"
  echo "Environment=NODE_ENV=production"
  # Pin the long-term port. The daemon refuses to bind 4010 from a checkout
  # without an explicit CITADEL_PORT, to keep ad-hoc invocations from
  # clobbering this service.
  echo "Environment=CITADEL_PORT=4010"
  echo "Environment=CITADEL_CONFIG=$CITADEL_CONFIG_PATH"
  echo "Environment=OPENCLAW_ROOT=$OPENCLAW_ROOT"
  echo "Environment=CITADEL_OPENCLAW_STATUS_TIMEOUT_MS=15000"
  echo "Environment=CITADEL_SHELL_BIN=$SHELL_BIN"
  # Routes every tmux invocation to citadel-tmux.service's server.
  echo "Environment=CITADEL_TMUX_SOCKET=$TMUX_SOCK"
  [[ -n "$TTYD_BIN" ]] && echo "Environment=TTYD_BIN=$TTYD_BIN"
  echo "Environment=PATH=$SERVICE_PATH"
  echo "ExecStart=$NODE_BIN $ROOT/apps/daemon/dist/index.js"
  echo "Restart=always"
  echo "RestartSec=3"
  # Kill only the main daemon on stop/restart — ttyd and tmux survive, the
  # next daemon discovers and adopts them. control-group kill would SIGTERM
  # the whole subtree and lose every terminal.
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

if $TMUX_UNIT_CHANGED || $CITADEL_UNIT_CHANGED; then
  systemctl --user daemon-reload
fi

systemctl --user enable citadel-tmux.service citadel.service >/dev/null 2>&1 || true

# Start citadel-tmux.service only when it's not already up. This script never
# *restarts* it — every agent session lives in that server, so a restart is a
# destructive act the user must initiate explicitly via `make tmux-service`.
TMUX_ACTIVE_STATE="$(systemctl --user show -p ActiveState --value citadel-tmux.service 2>/dev/null)"
if [[ "$TMUX_ACTIVE_STATE" != "active" ]]; then
  echo "→ start citadel-tmux.service"
  systemctl --user start citadel-tmux.service
  sleep 0.4
  if ! systemctl --user is-active --quiet citadel-tmux.service; then
    echo "✗ citadel-tmux.service failed to start"
    systemctl --user status citadel-tmux.service --no-pager | head -20
    exit 1
  fi
fi
echo "✓ citadel-tmux.service active (socket=$TMUX_SOCK)"

echo "→ pnpm build (so the supervised process has a fresh dist)"
( cd "$ROOT" && pnpm build )

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
