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

GitHub provider features use the local `gh` CLI when enabled. Jira provider features use the local `jtk` CLI when enabled. If a provider CLI is missing or unhealthy, Citadel reports the provider as degraded or unavailable and disables provider-backed actions in the cockpit.

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

### Deploy hook

The deploy hook surfaces the workspace's deployed apps in the cockpit (the "Local deploys" panel) and runs the redeploy when the operator clicks the chip. Citadel resolves it from two sources, in this priority:

1. **File** — an executable at `.citadel/hooks/<repo>/deploy` inside the workspace (`.citadel/hooks/deploy` relative to the worktree root). Useful when the script ships with the repo itself.
2. **Repo config** — `repo.deployHookCommand` declared per-repository in Citadel settings. Useful when the hook is operator-owned.

If both are present, the file wins; the repo config becomes the fallback when the file is missing or not executable. A non-executable file surfaces a diagnostic note in the cockpit (so a missing `chmod +x` is loud, not silent).

Contract (subcommands and structured I/O):

- `<hook> list` → stdout `{"apps":[{"name":string,"url":string}]}`. Must complete in ≤10s, no side effects.
- `<hook> redeploy [name]` → (re)starts the named app, or all apps if no name. stdout/stderr stream back to the cockpit operation log.

Environment provided by Citadel: `CITADEL_WORKSPACE_ID`, `CITADEL_WORKSPACE_PATH`, `CITADEL_WORKSPACE_BRANCH`, `CITADEL_REPO_ID`. The hook is spawned with `cwd = $CITADEL_WORKSPACE_PATH`.

The cockpit's deploy chip shows a spinner while the redeploy runs. If the redeploy hook restarts the daemon itself (as Citadel's own dev stack does — `make deploy` kills its own pgid), the cockpit keeps the spinner alive via a watchdog that polls `/api/state` until a newer `daemonStartedAt` token appears. Click-to-spinner latency is bounded to 1.5s even if the daemon is slow to answer the pre-fetch.

### Teardown hook

Teardown hooks run when a workspace is removed (not archived — archiving keeps the worktree on disk and skips both teardown paths). Like deploy, Citadel resolves teardown from two sources and runs both when both are present:

1. **File** — an executable at `.citadel/hooks/teardown` inside the workspace. Runs FIRST.
2. **Configured** — referenced from `repo.teardownHookIds` and declared in the top-level `hooks: [...]` list with `event: "workspace.teardown"`. Runs SECOND (after the file hook returns).

Ordering matters: file teardown runs before the configured hooks, and BOTH run before the tmux session kill / worktree prune / DB delete. A hook failure leaves the workspace state untouched (no tmux/worktree/DB damage) unless the operator passes the explicit force flag — in which case the failure is logged as a warning and cleanup proceeds.

Contract:

- `<hook>` (no subcommand) — runs once when the workspace is being removed. Exit 0 = success. Exit non-zero = failure.
- Environment provided: same vars as deploy (`CITADEL_WORKSPACE_ID`, `CITADEL_WORKSPACE_PATH`, `CITADEL_WORKSPACE_BRANCH`, `CITADEL_REPO_ID`). `cwd = $CITADEL_WORKSPACE_PATH`.
- Timeout: `commandPolicy.hookTimeoutMs` (default 120000). On timeout, Citadel SIGKILLs the hook's process group.
- stdout/stderr stream to the operation log under a `[teardown]` prefix.

Operator-visible failure semantics (3-state):

| State | `force` | Outcome |
|---|---|---|
| Hook absent | any | Skip file-teardown; continue with configured hooks (if any), then cleanup. |
| Hook fails | `false` | Operation marked failed (`error = "file teardown failed: <tail>"` or `"configured teardown failed: <message>"`). Activity emits `workspace.teardown.file.failed` and `workspace.remove.blocked`. No tmux/worktree/DB state touched. |
| Hook fails | `true` | Warning log line (`[teardown] ... continuing because force=true`), cleanup proceeds. |

**Anti-pattern: don't kill the daemon you're talking to.** A teardown hook that runs `make stop` (or otherwise kills the daemon currently executing the remove operation) will sever the HTTP connection mid-flight. The hook ran, but Citadel never gets to finish the cleanup — the workspace ends up half-removed (DB still tracks it, worktree still on disk). Citadel ships no `.citadel/hooks/teardown` for itself for exactly this reason; write a teardown hook only when it can run cleanly without taking down the daemon that's handling the removal.

`TeardownHookResolution` (in `@citadel/contracts`) covers only the file-based discovery path. Configured hooks are resolved separately by the hooks runner; both paths are invoked in `removeWorkspace`.

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
- `CITADEL_TTYD_PORT_BASE`, `CITADEL_TTYD_PORT_MAX` — inclusive port range used for ttyd allocation (default `7681..7720`). All ports are bound to `127.0.0.1`.

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
