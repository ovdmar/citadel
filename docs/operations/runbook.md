# Citadel v2 Runbook

## Local Development

```bash
make setup     # pnpm install
make deploy    # foreground HMR; prints the worktree-scoped cockpit URL
```

`make deploy` runs the daemon (`tsx watch`) and the Vite cockpit in parallel, scoped to the current checkout. Both bind worktree-derived ports (`4110-4209` for the daemon, `5210-5309` for vite) so multiple worktrees can run side-by-side without colliding with each other or with the systemd-supervised `citadel.service` (port `4010`).

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

## Terminal Runbook (ttyd)

Interactive terminals in the cockpit are rendered by per-session `ttyd` processes that the daemon spawns, supervises, and reverse-proxies.

**Required tools:** `tmux`, `ttyd`. The daemon resolves `ttyd` via `TTYD_BIN` (default `/home/linuxbrew/.linuxbrew/bin/ttyd`).

**How it works:**
- The cockpit calls `POST /api/agent-sessions/:sessionId/terminal` to ensure a ttyd is running for that session. The daemon allocates a free TCP port in `CITADEL_TTYD_PORT_BASE..CITADEL_TTYD_PORT_MAX` (default `7681..7720`), binds ttyd to `127.0.0.1:<port>` with `-b /terminals/<sessionId>` so it knows its proxied base path, and runs `bash -lc 'tmux attach -t <session>'` inside.
- The daemon proxies all HTTP and WebSocket traffic at `/terminals/:sessionId/*` to the matching ttyd. The cockpit renders `<iframe src="/terminals/:sessionId/">`.
- On daemon startup, any orphaned `ttyd` listening inside the configured port range is reaped (via `lsof -nP -iTCP -sTCP:LISTEN`).
- Stopping a Citadel session (`DELETE /api/agent-sessions/:id`) releases its ttyd. `DELETE /api/agent-sessions/:id/terminal` releases the ttyd without stopping the tmux session.

**Diagnostics:**

```bash
# List active ttyd records the daemon is aware of
curl -sS http://127.0.0.1:4010/api/terminals | jq

# Ask the daemon to ensure a ttyd for a known session
curl -sS -X POST http://127.0.0.1:4010/api/agent-sessions/<sessionId>/terminal | jq

# Forcefully release a stuck ttyd for a session
curl -sS -X DELETE http://127.0.0.1:4010/api/agent-sessions/<sessionId>/terminal
```

**Error codes** surfaced to the cockpit:
- `ttyd_missing` — `TTYD_BIN` does not point at an executable ttyd. Install ttyd or update the path.
- `no_free_port` — every port in the configured range is busy. Release stale terminals or widen the range.
- `ttyd_start_timeout` — ttyd was spawned but never listened. Inspect daemon logs and verify the shell command exits cleanly.
- `tmux_session_missing` — the underlying tmux session is gone (agent exited). Reconcile or recreate the session.
- `spawn_failed` — Node could not spawn ttyd. Check permissions and shell binary.
- `session_not_found` — Citadel does not know that session id. Refresh the cockpit.

**Diagnostic xterm gateway:** `/terminal/:sessionId` still exposes the legacy xterm/WebSocket bridge for tooling and tests. It is not used by the cockpit and is not the default renderer.

**Trade-offs accepted:** one external ttyd process per active terminal, dynamic loopback ports, and a proxy hop, in exchange for unmodified terminal fidelity (alt-screen TUIs like Claude Code, full colour, cursor, shortcut passthrough, paste).
