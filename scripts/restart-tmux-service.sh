#!/usr/bin/env bash
# Apply a citadel-tmux.service unit change (or recover from an orphan tmux
# server that grabbed the citadel socket). Destructive on purpose:
#   1. Stops citadel.service so the daemon stops spawning sessions.
#   2. Kills every tmux session on the citadel socket.
#   3. (Re)starts citadel-tmux.service so it now truly owns the socket.
#   4. Starts citadel.service. Daemon's boot-restore re-spawns every
#      recoverable agent session via `claude --resume <uuid>` — no
#      conversation state lost, only ephemeral terminal scrollback.
#
# Pass CITADEL_TMUX_FORCE=1 (or --force) to skip the confirmation prompt.

set -uo pipefail

FORCE=0
if [[ "${1:-}" == "--force" || "${CITADEL_TMUX_FORCE:-0}" == "1" ]]; then
  FORCE=1
fi

TMUX_SOCK="${CITADEL_TMUX_SOCKET:-citadel}"
TMUX_BIN_PATH="${TMUX_BIN_PATH:-$(command -v tmux || echo /usr/bin/tmux)}"

session_count() {
  "$TMUX_BIN_PATH" -L "$TMUX_SOCK" list-sessions 2>/dev/null | wc -l | tr -d ' '
}

LIVE=$(session_count)
echo "Citadel tmux service restart"
echo "  socket:        $TMUX_SOCK"
echo "  live sessions: $LIVE"
echo ""
echo "This restarts citadel-tmux.service. Every live tmux session will be"
echo "killed. The daemon's boot-restore brings each agent session back via"
echo "\`claude --resume <uuid>\` so conversations resume from disk history."
echo ""

if [[ "$FORCE" != "1" ]]; then
  read -r -p "Continue? [y/N] " ans
  case "$ans" in
    y|Y|yes|YES) ;;
    *) echo "aborted"; exit 1 ;;
  esac
fi

echo "→ stop citadel.service"
systemctl --user stop citadel.service || true
sleep 0.4

echo "→ tmux kill-server (socket=$TMUX_SOCK)"
"$TMUX_BIN_PATH" -L "$TMUX_SOCK" kill-server 2>/dev/null || true
sleep 0.4

echo "→ reset-failed + restart citadel-tmux.service"
systemctl --user reset-failed citadel-tmux.service 2>/dev/null || true
systemctl --user restart citadel-tmux.service
sleep 0.6
if ! systemctl --user is-active --quiet citadel-tmux.service; then
  echo "✗ citadel-tmux.service did not become active"
  systemctl --user status citadel-tmux.service --no-pager | head -20
  exit 1
fi
echo "✓ citadel-tmux.service active"

echo "→ start citadel.service"
systemctl --user start citadel.service
sleep 0.8
if ! systemctl --user is-active --quiet citadel.service; then
  echo "✗ citadel.service did not become active"
  systemctl --user status citadel.service --no-pager | head -20
  exit 1
fi
echo "✓ citadel.service active"

PORT="$(systemctl --user show -p Environment --value citadel.service 2>/dev/null | tr ' ' '\n' | sed -n 's/^CITADEL_PORT=//p')"
PORT="${PORT:-4010}"
echo "→ waiting for HTTP /healthz on :$PORT"
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/healthz" 2>/dev/null; then
    echo "✓ /healthz OK after ${i}s"
    break
  fi
  sleep 1
done

echo ""
echo "Boot-restore runs in the background. Open the cockpit to watch sessions"
echo "come back; the banner shows progress (restored N, failed M)."
