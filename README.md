# Citadel

Citadel v2 is a local-first Linux operator cockpit for repositories, workspaces, tmux-backed agent runtimes, providers, hooks, MCP, and operational activity.

## Quickstart (dev)

```bash
make setup     # pnpm install
make deploy    # detached HMR stack (daemon + vite); prints the cockpit URL
```

- Daemon (REST/SSE/WebSocket, serves built web): `http://127.0.0.1:4010` for the systemd long-term install; worktree dev uses derived ports `4110–4209`.
- Vite HMR cockpit (worktree dev): `5210–5309`.
- Default config: `~/.local/share/citadel/citadel.config.json`
- Default SQLite DB: `~/.local/share/citadel/citadel.sqlite`

The daemon binds `127.0.0.1` by default for local-first use. See [docs/operations/worktree-development.md](docs/operations/worktree-development.md) for the full mental model.

## Install (long-term)

```bash
make install                          # install latest released tag and refresh systemd --user units
make upgrade                          # reinstall/upgrade to latest released tag
make install REF=main                 # development install from latest origin/main
make upgrade REF=v0.3.0               # install a specific annotated release tag
make doctor                           # verify everything is configured
```

See [docs/operations/install.md](docs/operations/install.md) for pre-requisites, HTTPS setup (mkcert recipe), and verification details.

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
- [Install](docs/operations/install.md)
- [Hook examples](docs/operations/hook-examples.md)
- [Runbook](docs/operations/runbook.md)
- [Worktree development](docs/operations/worktree-development.md)
- [Engineering standards](docs/contributors/v2-engineering-standards.md)
- [Campaign log](docs/campaigns/citadel-v2-implementation-log.md)
