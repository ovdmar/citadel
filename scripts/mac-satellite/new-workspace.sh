#!/bin/sh
# Citadel new-workspace launcher (macOS).
#
# Opens the cockpit at /?modal=new-workspace in the user's default browser.
# The cockpit recognises the deeplink on mount, auto-opens the existing
# Create Workspace modal, and strips the param from the URL — so the user
# starts a new workspace without navigating through the cockpit shell.
#
# Daemon target: the long-term systemd Citadel daemon at 127.0.0.1:4010
# (overridable via CITADEL_HOST / CITADEL_PORT). See quick-capture.sh for
# why worktree daemons aren't auto-discovered.

set -eu

CITADEL_HOST="${CITADEL_HOST:-127.0.0.1}"
CITADEL_PORT="${CITADEL_PORT:-4010}"
URL="http://${CITADEL_HOST}:${CITADEL_PORT}/?modal=new-workspace"

if ! curl -fsS --max-time 2 "http://${CITADEL_HOST}:${CITADEL_PORT}/api/state" > /dev/null 2>&1 \
   && ! curl -fsS --max-time 2 "http://${CITADEL_HOST}:${CITADEL_PORT}/api/scratchpad" > /dev/null 2>&1; then
  osascript -e "display notification \"Citadel daemon not reachable at ${CITADEL_HOST}:${CITADEL_PORT}\" with title \"New workspace\""
  echo "citadel new-workspace: daemon not reachable at ${URL}" >&2
  exit 1
fi

# `open` opens in the user's default browser. Intentionally NOT a chromeless
# popup — the user wants to land in their pinned cockpit tab if they have one.
open "$URL"
