# Citadel

Citadel v2 is a local-first Linux operator cockpit for repositories, workspaces, tmux-backed agent runtimes, providers, hooks, MCP, and operational activity.

## Quickstart

```bash
pnpm install
make dev
```

- Daemon (REST/SSE/WebSocket, serves built web): `http://127.0.0.1:4010`
- Vite dev server for the web app (optional in dev): `http://127.0.0.1:5173`
- Default config: `~/.local/share/citadel/citadel.config.json`
- Default SQLite DB: `~/.local/share/citadel/citadel.sqlite`

The daemon binds `127.0.0.1` by default for local-first use.
`CITADEL_BASE_URL` and `CITADEL_WEB_URL` override the API and web URLs
used by `make smoke`, `make e2e`, and `make performance`.

## Checks

```bash
make check
make smoke
make e2e
```

Citadel uses pnpm, strict TypeScript project references, Biome, Vitest, Playwright, SQLite, tmux, REST/SSE for app state, and a dedicated WebSocket for terminal I/O.

## Docs

- [Product specs](specs/README.md)
- [Architecture](docs/architecture/citadel-v2-architecture.md)
- [Runbook](docs/operations/runbook.md)
- [Engineering standards](docs/contributors/v2-engineering-standards.md)
- [Campaign log](docs/campaigns/citadel-v2-implementation-log.md)
