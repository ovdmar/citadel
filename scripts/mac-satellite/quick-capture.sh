#!/bin/sh
# Citadel quick-capture launcher (macOS).
#
# Opens the daemon's /quick-capture page as a Spotlight-shaped chromeless
# popup so the user can dictate or type a thought and ⌘+Enter it into the
# global scratchpad. Bind to a global shortcut (e.g. cmd+shift+s) via
# Hammerspoon or Shortcuts.app — see README.md in this directory.
#
# Daemon target: the long-term systemd Citadel daemon at 127.0.0.1:4010.
# Worktree-isolated daemons (4110+ per CLAUDE.md) are deliberately NOT
# auto-discovered — a global shortcut cannot infer which worktree is "active".
# Override with CITADEL_HOST / CITADEL_PORT env vars if you want the shortcut
# bound to a specific worktree.

set -eu

CITADEL_HOST="${CITADEL_HOST:-127.0.0.1}"
CITADEL_PORT="${CITADEL_PORT:-4010}"
URL="http://${CITADEL_HOST}:${CITADEL_PORT}/quick-capture"

# Liveness probe — fail fast with a useful message rather than opening a blank
# tab. --max-time keeps us snappy for the global-shortcut UX.
if ! curl -fsS --max-time 2 "http://${CITADEL_HOST}:${CITADEL_PORT}/api/scratchpad" > /dev/null 2>&1; then
  osascript -e "display notification \"Citadel daemon not reachable at ${CITADEL_HOST}:${CITADEL_PORT}\" with title \"Quick capture\""
  echo "citadel quick-capture: daemon not reachable at ${URL}" >&2
  exit 1
fi

# Prefer Chrome --app= mode so the page renders chromeless and window.close()
# actually works after a successful capture. Fall back to Safari for users
# without Chrome (the page will show its "Press ⌘W to close" hint there).
CHROME=""
for candidate in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
do
  if [ -x "$candidate" ]; then
    CHROME="$candidate"
    break
  fi
done

if [ -n "$CHROME" ]; then
  # --user-data-dir keeps the satellite popup in its own profile so it doesn't
  # share state with the user's main browser. --window-size sizes the popup
  # roughly Spotlight-shaped; --window-position aims at the center of a
  # 1440-wide screen — the user can move it once and Chrome remembers.
  PROFILE_DIR="${HOME}/.cache/citadel-mac-satellite"
  mkdir -p "$PROFILE_DIR"
  "$CHROME" \
    --user-data-dir="$PROFILE_DIR" \
    --app="$URL" \
    --window-size=640,220 \
    --window-position=400,300 \
    >/dev/null 2>&1 &
else
  # Safari fallback — opens in a normal window; user closes with ⌘W after the
  # page's "Captured. Press ⌘W to close." confirmation.
  open -a Safari "$URL"
fi
