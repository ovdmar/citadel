# Citadel v2 Runbook

## Local Development

```bash
pnpm install
make dev
```

The daemon listens on `http://127.0.0.1:4337` by default. The Vite web app listens on `http://127.0.0.1:5173` and proxies API, SSE, and terminal WebSocket traffic to the daemon.

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

Mutating tools are handled by the daemon. `create_workspace`, `start_agent_session`, and `archive_workspace` use normalized Citadel concepts:

```bash
curl -sS -X POST http://127.0.0.1:4337/api/mcp/rpc \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"start_agent_session","arguments":{"workspaceId":"ws_example","runtimeId":"shell","displayName":"Shell"}}}'
```

This surface is for trusted local/internal deployments. Do not bind it to a public interface without adding an explicit authorization layer and network controls.
