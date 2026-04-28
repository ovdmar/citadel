#!/usr/bin/env bash
set -euo pipefail

LABEL="ai.openclaw.citadel"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAUNCH_AGENTS_DIR="${HOME}/Library/LaunchAgents"
PLIST_PATH="${LAUNCH_AGENTS_DIR}/${LABEL}.plist"
LOG_DIR="${HOME}/Library/Logs/Citadel"
NODE_BIN="${NODE_BIN:-$(command -v node)}"
PORT="${CITADEL_PORT:-4010}"

if [[ -z "${NODE_BIN}" ]]; then
  echo "node not found in PATH" >&2
  exit 1
fi

mkdir -p "${LAUNCH_AGENTS_DIR}" "${LOG_DIR}"

cat > "${PLIST_PATH}" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>WorkingDirectory</key>
    <string>${ROOT_DIR}</string>

    <key>ProgramArguments</key>
    <array>
      <string>${NODE_BIN}</string>
      <string>${ROOT_DIR}/dist/server/index.js</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
      <key>CITADEL_PORT</key>
      <string>${PORT}</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>${LOG_DIR}/stdout.log</string>

    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/stderr.log</string>
  </dict>
</plist>
PLIST

echo "Wrote ${PLIST_PATH}"
echo "Node: ${NODE_BIN}"
echo "Root: ${ROOT_DIR}"
echo "Logs: ${LOG_DIR}"
