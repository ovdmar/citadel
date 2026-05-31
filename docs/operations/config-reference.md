# Citadel v2 Configuration Reference

Citadel stores static local configuration in `~/.local/share/citadel/citadel.config.json` by default. Set `CITADEL_CONFIG` to use a different file or `CITADEL_DATA_DIR` to move the default config and SQLite database together. Config files are written with mode `0600`.

## Local Server

- `bindHost`: defaults to `127.0.0.1`.
- `port`: defaults to `4337`.
- `mcp.enabled`: defaults to `true` for trusted local/internal deployments.

Do not bind Citadel or MCP endpoints to a public interface without adding an explicit authorization layer and network controls.

## Providers

Bundled provider toggles:

```json
{
  "providers": {
    "github": { "enabled": true },
    "jira": { "enabled": true }
  }
}
```

GitHub provider features use the local `gh` CLI when enabled. Jira provider features use the local `jtk` CLI when enabled. If a provider CLI is missing or unhealthy, Citadel reports the provider as degraded or unavailable and disables provider-backed actions in the cockpit. Worktree deploys started by `make deploy` disable automated GitHub polling by default (`CITADEL_AUTOMATED_GH=0`); set `CITADEL_ENABLE_WORKTREE_GH_AUTOMATION=1` before `make deploy` to opt one worktree back in. The long-term systemd install sets `CITADEL_AUTOMATED_GH=1`.

## Runtimes

Runtimes are shell-backed command adapters launched through tmux:

```json
{
  "runtimes": [
    { "id": "codex", "displayName": "Codex", "command": "codex", "args": ["--yolo"] },
    { "id": "shell", "displayName": "Shell", "command": "bash", "args": ["-l"] }
  ]
}
```

Built-in defaults include `claude-code`, `codex`, `cursor-agent`, `pi`, and `shell`. Codex defaults to `--yolo` so interactive launches use the CLI's no-approval/no-sandbox mode; edit or clear the runtime args in Settings to change that. Runtime health is derived from command availability. Agent sessions persist tmux session name/id for reconnect.

Citadel launches Codex with a workspace-scoped `CODEX_SQLITE_HOME` under
`${dataDir}/codex-sqlite/<workspaceId>`. User auth/config and transcript/history
entries stay in the operator's global Codex home, but SQLite-backed runtime
state is isolated so live Codex sessions do not contend on the same global
SQLite files.

## Runtime Usage Providers

Usage providers are runtime-scoped command collectors. A configured command receives no special Citadel state today and must print JSON to stdout:

```json
{
  "usageProviders": [
    {
      "id": "codex-usage",
      "runtimeId": "codex",
      "command": "codex-usage",
      "args": ["--json"]
    }
  ]
}
```

Expected stdout fields:

```json
{
  "source": "codex-usage",
  "status": "healthy",
  "model": "gpt",
  "remaining": "42%",
  "spend": "$1.25",
  "resetAt": "2026-05-18T00:00:00.000Z"
}
```

If no usage provider is configured for a runtime, Citadel returns an explicit `unavailable` usage summary rather than guessing.

## Automations

The fix-CI automation is configurable from Settings -> Automations and persists under `automations.fixCi`:

```json
{
  "automations": {
    "fixCi": {
      "enabled": true,
      "runtimeId": "claude-code",
      "fallbackRuntimeId": "codex",
      "idleThresholdMs": 300000,
      "debounceMs": 1800000,
      "intervalMs": 60000
    }
  }
}
```

When PR checks are failing and the workspace is idle, Citadel launches the primary runtime only if its health is `healthy`; otherwise it tries the configured fallback. Set `fallbackRuntimeId` to `null` to skip auto-repair when the primary runtime is unavailable.

## Hooks

Command hooks run with JSON input on stdin, bounded stdout/stderr capture, and a timeout from `commandPolicy.hookTimeoutMs`.

Supported events:

- `workspace.setup`
- `workspace.teardown`
- `workspace.created`
- `workspace.archived`
- `workspace.removed`
- `agent.started`

Example:

```json
{
  "hooks": [
    {
      "id": "workspace-links",
      "kind": "command",
      "event": "workspace.created",
      "command": "node",
      "args": ["/opt/citadel-hooks/workspace-links.js"],
      "blocking": false
    }
  ],
  "repoDefaults": {
    "setupHookIds": [],
    "teardownHookIds": []
  },
  "commandPolicy": {
    "hookTimeoutMs": 120000,
    "allowDestructiveWorkspaceCleanup": false
  }
}
```

Setup and teardown hooks default to blocking. Lifecycle notification hooks default to non-blocking. Setup failures mark workspace creation failed. Teardown failures block destructive cleanup unless the operator uses explicit force cleanup.

Successful hooks may print structured output:

```json
{
  "links": [{ "label": "Preview", "url": "https://example.test/preview", "kind": "preview" }],
  "actions": [{ "id": "redeploy", "label": "Redeploy", "url": "https://example.test/deploy" }],
  "metadata": { "environment": "staging" }
}
```

Citadel persists this output on activity events, renders links/actions in the cockpit, and exposes them through MCP `list_workspace_links`.

## MCP

MCP is exposed through local/internal HTTP endpoints:

- `GET /api/mcp/status`
- `POST /api/mcp/tools/call`
- `POST /api/mcp/rpc`

Resources:

- `citadel://repos`
- `citadel://workspaces`
- `citadel://provider-health`
- `citadel://activity`

Tools include read-only state inspection (including `read_agent_output`, which returns the latest tmux pane content for a specific agent session, bounded by `lines` and `maxChars`) plus daemon-handled workspace creation, agent launch, follow-up agent messaging (`send_agent_message`), metadata archive, and workspace link listing. See [runbook.md](./runbook.md) for curl examples.

For interactive runtimes like Claude Code, an initial `prompt` passed to `start_agent_session` and every `send_agent_message` are delivered into the tmux pane via paste-buffer + Enter, so the prompt is actually submitted to the agent and not just left in the input box. Citadel ships `claude-code` without `promptArg` for this reason — `-p` is Claude Code's non-interactive print mode, which exits after responding and is not what an interactive Citadel session needs.

## Terminal Renderer

Shell-backed sessions are tmux sessions. The cockpit's interactive renderer is an in-process xterm.js pane connected to the daemon WebSocket at `/terminal/:sessionId`. The daemon bridges that socket to the matching tmux session with node-pty running `tmux attach-session`, so normal workspace and agent switching does not spawn one renderer process per session and interactive TUIs get real PTY behavior.

Environment variables:

- `CITADEL_TMUX_SOCKET` — tmux socket name used by the daemon and terminal bridge.
- `CITADEL_SHELL_BIN` — shell used when Citadel creates shell-first tmux sessions (default `$SHELL` then `/bin/bash`).

Lifecycle:

- Opening a terminal WebSocket spawns one disposable node-pty viewer process for `tmux attach-session`.
- Closing the WebSocket kills that viewer process with `SIGHUP`; the durable tmux session and agent process remain alive.
- Stopping a session kills the underlying tmux session and deletes the session row.

## WebSocket Terminal Gateway

The xterm/WebSocket gateway is exposed at `/terminal/:sessionId`:

- terminal input/output bytes move as binary WebSocket frames,
- JSON control messages carry resize and error/exit events,
- reconnect attaches to the same tmux session and resumes from tmux's current visible state plus live PTY output.

This gateway is the cockpit renderer and is also used for scripted tests or remote debugging.
