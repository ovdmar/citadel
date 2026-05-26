#!/usr/bin/env bash
# Citadel deploy hook — canonical template.
#
# This file is the starting point the cockpit's "Scaffold with AI" agent
# uses to author .citadel/hooks/deploy for a new repo. Keep it in sync with
# the contract; the AI agent reads it and adapts to the operator's repo.
#
# Contract:
#   $1 = subcommand
#     list                 → stdout JSON: {"apps":[{"name":"<app>","url":"http://<host>:<port>"}]}
#                           must complete in ≤10s; no side effects.
#     redeploy [name]      → (re)starts the named app, or all apps if no name.
#                           stdout/stderr stream back to the cockpit operation log.
#
# Environment provided by Citadel:
#   CITADEL_WORKSPACE_ID    — opaque workspace id
#   CITADEL_WORKSPACE_PATH  — absolute path to the worktree (same as cwd)
#   CITADEL_WORKSPACE_BRANCH
#   CITADEL_REPO_ID
#
# Optional override:
#   CITADEL_PUBLIC_HOST     — host to advertise in the URL (defaults to the
#                            machine's primary non-loopback IPv4, falling
#                            back to 127.0.0.1).
#
# Validate by running:
#   ./.citadel/hooks/deploy list | jq .
#
# Make it executable:
#   chmod +x .citadel/hooks/deploy

set -euo pipefail

APP_NAME="${MY_APP:-app}"
WORKTREE="${CITADEL_WORKSPACE_PATH:-$(pwd)}"

# Replace these with your repo's actual port/URL derivation. The Citadel
# reference at .citadel/hooks/deploy reads them from .citadel/dev.json
# (written by `make deploy`); your repo's hook can derive them from a
# Makefile target, environment file, kubectl, or any other discovery
# mechanism.
PORT="${MY_PORT:-3000}"
HOST="${CITADEL_PUBLIC_HOST:-127.0.0.1}"

case "${1:-}" in
  list)
    printf '{"apps":[{"name":"%s","url":"http://%s:%d"}]}\n' "$APP_NAME" "$HOST" "$PORT"
    ;;
  redeploy)
    # Replace `make dev-deploy "${2:-}"` with whatever restarts your app.
    # stdout/stderr stream back to the cockpit operation log.
    make dev-deploy "${2:-}"
    ;;
  *)
    echo "unknown subcommand: ${1:-<none>}" >&2
    exit 2
    ;;
esac
