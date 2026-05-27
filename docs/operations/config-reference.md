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
    { "id": "codex", "displayName": "Codex", "command": "codex", "args": [] },
    { "id": "shell", "displayName": "Shell", "command": "bash", "args": ["-l"] }
  ]
}
```

Built-in defaults include `claude-code`, `codex`, `cursor-agent`, `pi`, and `shell`. Runtime health is derived from command availability. Agent sessions persist tmux session name/id for reconnect.

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

## Terminal Renderer (ttyd)

Shell-backed sessions are tmux sessions. The cockpit's interactive renderer is `ttyd`, run as a per-session child process and reverse-proxied through the daemon at `/terminals/:sessionId/*`.

Environment variables:

- `TTYD_BIN` — absolute path to the ttyd binary (default `/home/linuxbrew/.linuxbrew/bin/ttyd`).
- `CITADEL_SHELL_BIN` — shell used to wrap `tmux attach` (default `$SHELL` then `/bin/bash`).
- `CITADEL_TTYD_PORT_BASE`, `CITADEL_TTYD_PORT_MAX` — inclusive port range used for ttyd allocation. When unset, the daemon picks a per-instance 200-port slot starting at `7721 + 200 * ((daemonPort - 4010) mod 11)`, giving 11 disjoint slices in `7721..9920`. All ports are bound to `127.0.0.1`.

Lifecycle:

- A ttyd process is spawned the first time the cockpit hits `POST /api/agent-sessions/:sessionId/terminal`. ttyd is launched with `-W --check-origin=false -i 127.0.0.1 -b /terminals/<sessionId>` and runs `bash -lc 'tmux attach -t <session>'`.
- Stopping a session releases its ttyd. `DELETE /api/agent-sessions/:id/terminal` releases without stopping tmux.
- On daemon startup, stale `ttyd` processes that listen inside the configured port range are reaped.

## Diagnostic Terminal Gateway

A separate xterm/WebSocket gateway is still exposed at `/terminal/:sessionId` for tooling and tests:

- reconnect sends a bounded visible-screen snapshot,
- live output streams from tmux control mode as incremental chunks,
- input, paste, and resize are relayed to tmux.

This gateway is *not* the cockpit's default renderer. Use it for scripted tests or remote debugging only.
