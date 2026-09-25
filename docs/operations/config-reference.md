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

## Agent Runtimes And Terminal

Agent runtimes are prompt-driven command adapters launched through tmux:

```json
{
  "agentSessions": {
    "baseSystemPrompt": "You are running inside Citadel..."
  },
  "agentRuntimes": [
    {
      "id": "codex",
      "displayName": "Codex",
      "command": "codex",
      "args": ["--yolo", "--enable", "goals"],
      "launchOptions": {
        "systemPromptArgv": {
          "argv": ["-c", "developer_instructions={value}"],
          "valueEncoding": "toml-string"
        }
      }
    }
  ],
  "terminal": { "displayName": "Terminal", "command": "bash", "args": ["-l"] }
}
```

Built-in agent defaults include `claude-code`, `codex`, `cursor-agent`, and `pi`. Plain shell is the singular `terminal` profile, not an agent runtime. Codex defaults to `--yolo` so interactive launches use the CLI's no-approval/no-sandbox mode; edit or clear the runtime args in Settings to change that. Citadel keeps `--enable goals` on the Codex runtime so all Citadel-launched Codex sessions use the experimental goals feature. Agent runtime health is derived from command availability. Workspace sessions persist tmux session name/id for reconnect.

`agentSessions.baseSystemPrompt` is a single global prompt prefix configured from Settings -> Agents. Freestyle agent sessions use it as their system prompt. Specialized role sessions receive the global base prompt first and the Agents-tab role template system prompt second. Public API/MCP callers may provide supplemental system-prompt text for their own launch, but they cannot suppress the global base prompt or provide trusted role/source metadata.

Runtime launch options may declare native system-prompt delivery. The built-in Claude Code runtime uses `--append-system-prompt`; the built-in Codex runtime uses `-c developer_instructions=<toml-string>`. Cursor Agent, Pi, and custom runtimes without a `systemPromptArgv` mapping receive one pasted first message with a delimited Citadel system-instructions block and user-task block. Native argv delivery can be visible to local process inspection while the runtime starts; pasted fallback is visible in the agent transcript by design. Persisted prompt snapshots are internal audit/debug metadata, not a secret store.

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

### Undeploy hook

The undeploy hook is an optional companion file at `.citadel/hooks/undeploy`. It has no repo-config fallback. When present and executable, Citadel shows an X beside redeploy controls for apps whose current probe status is `deployed`.

Contract:

- `<hook> [name]` → stops the named app, or all apps if no name. stdout/stderr stream back to the cockpit operation log.

Environment and cwd match the deploy hook. A non-executable file surfaces a diagnostic note in the Local deploys panel.

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

Tools include read-only state inspection (including `read_agent_output`, which returns the latest tmux pane content for a specific agent session, bounded by `lines` and `maxChars`) plus daemon-handled workspace creation, agent launch, follow-up agent messaging (`send_agent_message`), metadata archive, and workspace link listing. MCP is agent-only: terminal workspace sessions are not listed, launched, read, or messaged through MCP. See [runbook.md](./runbook.md) for curl examples.

For interactive runtimes like Claude Code, an initial `prompt` passed to `start_agent_session` and every `send_agent_message` are delivered into the tmux pane via paste-buffer + Enter, so the prompt is actually submitted to the agent and not just left in the input box. Citadel ships `claude-code` without `promptArg` for this reason — `-p` is Claude Code's non-interactive print mode, which exits after responding and is not what an interactive Citadel session needs. If a runtime has no native system-prompt append support, Citadel combines the system-instructions wrapper and initial prompt into that pasted first message.

## Terminal Renderer

Workspace sessions are tmux sessions. Agent sessions use the configured terminal profile as their base shell before Citadel sends the agent runtime command. Terminal sessions run only the terminal profile. The cockpit's interactive renderer is an in-process xterm.js pane connected to the daemon WebSocket at `/terminal/:sessionId`. The daemon bridges that socket to the matching tmux session with node-pty running `tmux attach-session`, so normal workspace and session switching does not spawn one renderer process per session and interactive TUIs get real PTY behavior.

Environment variables:

- `CITADEL_TMUX_SOCKET` — tmux socket name used by the daemon and terminal bridge.
- `CITADEL_TMUX_HISTORY_LIMIT` — tmux scrollback lines per pane (default `20000`, clamped to `1000`-`100000`).
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
