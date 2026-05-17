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

## Verification

```bash
make check
make smoke
make e2e
```

`make check` is intended to cover architecture boundaries, file size, typecheck, Biome, unit tests, coverage, dependency policy, and build.
