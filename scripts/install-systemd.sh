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
TMUX_UNIT_TMP="$(mktemp)"
{
  echo "[Unit]"
  echo "Description=Citadel tmux server (long-lived; survives citadel.service restarts)"
  echo ""
  echo "[Service]"
  # `tmux -L $SOCK -F` runs the server in the FOREGROUND. With Type=simple,
  # systemd tracks the actual server process — `Restart=on-failure` finally
  # fires on tmux crashes (the previous Type=forking + RemainAfterExit=yes
  # made systemd think the unit was healthy when tmux had SEGV'd; that's
  # what hid both 2026-05-26 incidents from auto-restart).
  echo "Type=simple"
  echo "Environment=PATH=$SERVICE_PATH"
  echo "ExecStart=$TMUX_BIN_PATH -L $TMUX_SOCK -F"
  echo "Restart=on-failure"
  echo "RestartSec=2"
  # Default KillMode=control-group is fine here — when this unit stops, we
  # want the tmux server (and every agent session inside) to be torn down
  # together. The whole point of separating it is that *citadel.service*
  # restarts don't reach into this cgroup.
  echo ""
  echo "[Install]"
  echo "WantedBy=default.target"
} > "$TMUX_UNIT_TMP"

# Hash-compare against the installed unit so we only `systemctl restart` when
# the unit content actually changed. Blanket-restarting on every `make install`
# would re-trigger boot-restore's spawn cascade for no behavioural change.
TMUX_UNIT_CHANGED=false
if ! cmp -s "$TMUX_UNIT_TMP" "$TMUX_UNIT_PATH" 2>/dev/null; then
  TMUX_UNIT_CHANGED=true
  mv "$TMUX_UNIT_TMP" "$TMUX_UNIT_PATH"
  echo "  ↳ citadel-tmux.service content changed; will restart"
else
  rm -f "$TMUX_UNIT_TMP"
  echo "  ↳ citadel-tmux.service content unchanged; skipping restart"
fi

echo "→ Installing citadel.service → $ROOT"
CITADEL_UNIT_TMP="$(mktemp)"
{
  echo "[Unit]"
  echo "Description=Citadel local operator cockpit"
  echo "After=network-online.target citadel-tmux.service"
  echo "Wants=network-online.target"
  # Soft dependency on the tmux server: systemd brings tmux up alongside
  # citadel, but a tmux crash no longer forces citadel to restart. Combined
  # with Type=simple on the tmux unit (systemd tracks the actual process
  # and auto-restarts on failure), tmux is back in ~2 s and the daemon
  # detects the new server on its next status-monitor tick without losing
  # any non-tmux state. The previous Requires= forced a daemon restart
  # cascade — boot-restore would re-spawn every session, hammering load avg.
  echo "Wants=citadel-tmux.service"
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
  # Kill only the main daemon on stop/restart. ttyd children are spawned
  # detached so they outlive a daemon restart; the next boot's
  # discoverExistingTtyds() adopts them back into the manager. With the
  # default control-group kill mode, systemd would SIGTERM every PID in
  # the cgroup and we'd lose terminal sessions on every restart.
  echo "KillMode=process"
  echo ""
  echo "[Install]"
  echo "WantedBy=default.target"
} > "$CITADEL_UNIT_TMP"

CITADEL_UNIT_CHANGED=false
if ! cmp -s "$CITADEL_UNIT_TMP" "$UNIT_PATH" 2>/dev/null; then
  CITADEL_UNIT_CHANGED=true
  mv "$CITADEL_UNIT_TMP" "$UNIT_PATH"
  echo "  ↳ citadel.service content changed; will restart"
else
  rm -f "$CITADEL_UNIT_TMP"
  echo "  ↳ citadel.service content unchanged; skipping restart"
fi

if $TMUX_UNIT_CHANGED || $CITADEL_UNIT_CHANGED; then
  echo "→ daemon-reload"
  systemctl --user daemon-reload
fi

echo "→ enable citadel-tmux.service"
systemctl --user enable citadel-tmux.service >/dev/null 2>&1 || true
if $TMUX_UNIT_CHANGED || ! systemctl --user is-active --quiet citadel-tmux.service; then
  echo "→ (re)start citadel-tmux.service"
  systemctl --user restart citadel-tmux.service
fi
sleep 0.4
if ! systemctl --user is-active --quiet citadel-tmux.service; then
  echo "✗ citadel-tmux.service failed to start"
  systemctl --user status citadel-tmux.service --no-pager | head -20
  exit 1
fi
echo "✓ citadel-tmux.service running (socket=$TMUX_SOCK)"

echo "→ pnpm build (so the supervised process has a fresh dist)"
( cd "$ROOT" && pnpm build )

echo "→ enable citadel.service"
systemctl --user enable citadel.service >/dev/null 2>&1 || true
# Always restart citadel.service when content changed OR when the new build
# needs to be picked up (this is the normal `make install` rebuild path).
echo "→ restart citadel.service"
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
