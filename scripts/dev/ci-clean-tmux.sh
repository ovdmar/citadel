#!/usr/bin/env bash
set -euo pipefail

# GitHub's runner is isolated, but local `make ci` must not kill user tmux
# sessions. Clean only Citadel test sockets unless CI_CLEAN_ALL_TMUX=1 is set.
dir="/tmp/tmux-$(id -u)"
clean_all="${CI_CLEAN_ALL_TMUX:-0}"

if [[ ! -d "$dir" ]]; then
  exit 0
fi

shopt -s nullglob
for socket in "$dir"/*; do
  name="$(basename "$socket")"
  if [[ "$clean_all" == "1" || "$name" =~ ^citadel-(playwright|vitest|perf)- ]]; then
    tmux -L "$name" kill-server >/dev/null 2>&1 || true
    rm -f "$socket" || true
  fi
done
