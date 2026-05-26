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
TMUX_UNIT_PATH="$UNIT_DIR/citadel-tmux.service"
mkdir -p "$UNIT_DIR"

# Citadel's tmux server lives in its own user unit so the server survives
# citadel.service restarts/upgrades. Citadel talks to it via -L "$SOCK"
# (CITADEL_TMUX_SOCKET); see packages/terminal/src/index.ts:tmuxPrefix.
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

echo "→ Installing citadel-tmux.service (tmux server, socket=$TMUX_SOCK)"
{
  echo "[Unit]"
  echo "Description=Citadel tmux server (long-lived; survives citadel.service restarts)"
  echo ""
  echo "[Service]"
  # `tmux new-session -d` daemonises and exits — Type=forking matches that.
  # The __citadel_keepalive session keeps the server alive even when all
  # real agent sessions are closed, so the server doesn't churn on idle.
  echo "Type=forking"
  echo "Environment=PATH=$SERVICE_PATH"
  echo "ExecStart=$TMUX_BIN_PATH -L $TMUX_SOCK new-session -d -s __citadel_keepalive 'sleep infinity'"
  echo "ExecStop=$TMUX_BIN_PATH -L $TMUX_SOCK kill-server"
  echo "RemainAfterExit=yes"
  echo "Restart=on-failure"
  echo "RestartSec=2"
  # Default KillMode=control-group is fine here — when this unit stops, we
  # want the tmux server (and every agent session inside) to be torn down
  # together. The whole point of separating it is that *citadel.service*
  # restarts don't reach into this cgroup.
  echo ""
  echo "[Install]"
  echo "WantedBy=default.target"
} > "$TMUX_UNIT_PATH"

echo "→ Installing citadel.service → $ROOT"
{
  echo "[Unit]"
  echo "Description=Citadel local operator cockpit"
  echo "After=network-online.target citadel-tmux.service"
  echo "Wants=network-online.target"
  # Hard dependency: if the tmux server isn't up, the daemon can't manage
  # agent panes. Requires= triggers citadel-tmux.service start when citadel
  # starts; BindsTo is intentionally NOT used (we want citadel to keep
  # running even if tmux is being restarted manually).
  echo "Requires=citadel-tmux.service"
  echo ""
  echo "[Service]"
  echo "Type=simple"
  echo "WorkingDirectory=$ROOT"
  echo "Environment=NODE_ENV=production"
  # Pin the long-term port explicitly. The daemon refuses to bind 4010 when
  # launched from a checkout without an explicit CITADEL_PORT, to keep ad-hoc
  # `node dist/index.js` invocations from clobbering this service.
  echo "Environment=CITADEL_PORT=4010"
  echo "Environment=CITADEL_CONFIG=$CITADEL_CONFIG_PATH"
  echo "Environment=OPENCLAW_ROOT=$OPENCLAW_ROOT"
  echo "Environment=CITADEL_OPENCLAW_STATUS_TIMEOUT_MS=15000"
  echo "Environment=CITADEL_SHELL_BIN=$SHELL_BIN"
  # Routes every tmux invocation in the daemon to citadel-tmux.service's
  # server. See packages/terminal/src/index.ts:tmuxPrefix.
  echo "Environment=CITADEL_TMUX_SOCKET=$TMUX_SOCK"
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

# Make sure the tmux server is up under its own unit BEFORE we (re)start
# citadel.service — that way citadel's first tmux call hits the new
# dedicated socket, and any existing agent sessions on the old server stay
# untouched on the user's default socket (recoverable separately).
echo "→ enable --now citadel-tmux.service"
systemctl --user enable --now citadel-tmux.service
sleep 0.4
if ! systemctl --user is-active --quiet citadel-tmux.service; then
  echo "✗ citadel-tmux.service failed to start"
  systemctl --user status citadel-tmux.service --no-pager | head -20
  exit 1
fi
echo "✓ citadel-tmux.service running (socket=$TMUX_SOCK)"

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
