# Citadel v2 Runbook

## Local Development

```bash
make setup     # pnpm install
make deploy    # detached HMR stack; prints the worktree-scoped cockpit URL
```

`make deploy` is the only dev command. It detaches an HMR stack (daemon under `tsx watch` + vite under HMR, one process group) scoped to the current checkout. Worktree-derived ports (`4110-4209` daemon, `5210-5309` vite) keep multiple worktrees from colliding with each other or with the systemd-supervised `citadel.service` (port `4010`). The cockpit's Redeploy chip runs the same `make deploy`.

See [worktree-development.md](./worktree-development.md) for the full mental model, port derivation, and troubleshooting.

> Port `3000` is reserved for Grafana on operator machines. Do not bind any Citadel surface to it.

## State

Default config: `~/.local/share/citadel/citadel.config.json`

Default SQLite database: `~/.local/share/citadel/citadel.sqlite`

Set `CITADEL_DATA_DIR` or `CITADEL_CONFIG` to override local paths.

See [config-reference.md](./config-reference.md) for providers, runtimes, usage providers, hooks, MCP resources/tools, and terminal gateway behavior.

## Verification

```bash
make check
make smoke
make e2e
```

`make check` is intended to cover architecture boundaries, file size, typecheck, Biome, unit tests, coverage, dependency policy, and build.

## Local MCP Status

MCP is enabled by default for local/internal deployments. The v2 surface exposes normalized status/resources, JSON-RPC-style tools, and a local JSON tool-call shim:

```bash
curl -sS http://127.0.0.1:4337/api/mcp/status
curl -sS -X POST http://127.0.0.1:4337/api/mcp/tools/call \
  -H 'content-type: application/json' \
  -d '{"name":"inspect_status"}'
curl -sS -X POST http://127.0.0.1:4337/api/mcp/rpc \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Mutating tools are handled by the daemon. `create_workspace`, `start_agent_session`, `send_agent_message`, and `archive_workspace` use normalized Citadel concepts:

```bash
curl -sS -X POST http://127.0.0.1:4337/api/mcp/rpc \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"start_agent_session","arguments":{"workspaceId":"ws_example","runtimeId":"shell","displayName":"Shell"}}}'
```

### Reading agent output and sending follow-ups

```bash
# List agent sessions and their status / runtime / tmux session id.
curl -sS -X POST http://127.0.0.1:4337/api/mcp/rpc \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_agent_sessions","arguments":{}}}'

# Read the latest terminal output (transcript) of a specific session,
# bounded by lines and maxChars so the response stays small.
curl -sS -X POST http://127.0.0.1:4337/api/mcp/rpc \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"read_agent_output","arguments":{"sessionId":"sess_example","lines":200,"maxChars":16000}}}'

# Submit a follow-up message to a Claude Code (or any tmux-backed) session.
# The message is delivered into the pane as a paste buffer followed by Enter,
# so the agent actually processes it instead of just seeing it in the input box.
curl -sS -X POST http://127.0.0.1:4337/api/mcp/rpc \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"send_agent_message","arguments":{"sessionId":"sess_example","message":"Please also add a test for the empty state."}}}'
```

The same operations are exposed as REST mirrors for non-MCP clients:

```bash
curl -sS http://127.0.0.1:4337/api/agent-sessions/<sessionId>/output?lines=200&maxChars=16000
curl -sS -X POST http://127.0.0.1:4337/api/agent-sessions/<sessionId>/messages \
  -H 'content-type: application/json' \
  -d '{"message":"Please also add a test for the empty state."}'
```

This surface is for trusted local/internal deployments. Do not bind it to a public interface without adding an explicit authorization layer and network controls.

## Terminal Runbook

Interactive terminals in the cockpit use Citadel's xterm.js WebSocket renderer. The browser connects to `/terminal/<sessionId>`, the daemon attaches a disposable node-pty `tmux attach-session` viewer to the durable tmux session, and terminal bytes stream directly between xterm.js and that PTY.

**Required tools:** `tmux`. The PTY bridge is provided by the `node-pty` package built during `pnpm install`.

**How it works:**
- The cockpit opens `ws(s)://<host>/terminal/<sessionId>` for the renderer. No terminal iframe or external renderer process is created for normal workspace switching.
- Input/output bytes move as binary WebSocket frames. JSON control messages are reserved for resize and error/exit notifications.
- Closing or refreshing the browser pane kills only the disposable viewer process; the tmux session and agent continue.
- Stopping a Citadel session (`DELETE /api/agent-sessions/:id`) kills the durable tmux session.
- The terminal reaper periodically detaches orphaned tmux clients whose owning viewer process is gone.

**Diagnostics:**

```bash
# Verify daemon health
curl -sS http://127.0.0.1:4010/api/health | jq

# Inspect the daemon's terminal/tmux snapshot
curl -sS http://127.0.0.1:4010/api/diagnostics/snapshot | jq '.tmuxLiveSessions, .sessions'

# Read bounded pane output for a known session
curl -sS 'http://127.0.0.1:4010/api/agent-sessions/<sessionId>/output?lines=120&maxChars=20000' | jq
```

**Error codes** surfaced to the cockpit:
- `tmux_session_missing` — the underlying tmux session is gone (agent exited). Reconcile or recreate the session.
- `spawn_failed` — Node could not spawn the PTY-backed tmux attach viewer. Check tmux availability and daemon permissions.
- `session_not_found` — Citadel does not know that session id. Refresh the cockpit.
- `terminal_disconnected` / `terminal_socket_error` / `terminal_closed` — the browser viewer detached. Retry reconnects to the same tmux session if it still exists.

**Trade-offs accepted:** Citadel owns a small node-pty bridge using xterm.js rather than delegating every cockpit pane to an external terminal server. This preserves native PTY behavior for interactive CLIs while removing per-session renderer RSS and iframe startup from normal navigation.
