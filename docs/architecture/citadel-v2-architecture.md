# Citadel v2 Architecture

Citadel v2 is a local-first Linux daemon and operator web UI for managing repositories, workspaces, tmux-backed agent runtimes, providers, hooks, MCP, and operational activity. The core model is agent/workflow neutral. OpenClaw is not a core dependency; any future OpenClaw usage must happen as an external consumer through Citadel MCP, API, hooks, or provider surfaces.

## Package Boundaries

- `apps/daemon`: local backend process, REST API, SSE events, terminal WebSocket, operation runner.
- `apps/web`: React, Vite, TanStack Router, TanStack Query operator UI.
- `apps/cli`: reserved for thin local helpers after the web first-run path.
- `packages/core`: pure domain/state-machine code only.
- `packages/contracts`: shared Zod schemas and API/event DTOs.
- `packages/config`: versioned config loading and validation.
- `packages/db`: SQLite schema, migrations, repositories, and transaction helpers.
- `packages/operations`: side-effectful workflows such as workspace create/remove and agent launch.
- `packages/terminal`: tmux gateway and terminal WebSocket protocol.
- `packages/runtimes`: agent runtime provider contracts and built-in shell-backed adapters.
- `packages/providers`: version-control, PR, CI, issue-tracker, usage, and notification providers.
- `packages/hooks`: hook contracts, command execution, and event dispatch.
- `packages/mcp`: MCP tools/resources over normalized Citadel concepts.
- `packages/ui`: shared UI components only where reuse is real.
- `packages/testing`: fixtures, fake providers/runtimes, and e2e helpers.

Static checks enforce that core does not import implementation packages and that the web app does not import daemon/server internals.

## Domain Model

Core entities are repositories, workspaces, agent sessions, runtimes, providers, operations, hooks, activity events, sections, and MCP resources. Repositories and workspaces use generated stable IDs; path/name are metadata, not identity. Workspace lifecycle states are `creating`, `ready`, `failed`, `removing`, `archived`, and `removed`. Agent session process states are separate from browser terminal transport states.

## Persistence And Config

SQLite is the mutable state baseline. The database owns repos, workspaces, operations, activity, agent sessions, provider health snapshots, sections, UI preferences, and runtime state. The config file owns static defaults, providers, adapters, hooks, repo defaults, and command policy. Migrations are forward-only for v2; rollback is backup/restore.

## Operations And Events

Long-running work returns operation IDs and runs through the operation service. Operations persist progress, bounded logs/errors, and activity records. SSE is the app-state event channel. Interactive terminal traffic uses a dedicated WebSocket scoped by session ID.

## Providers And Hooks

Providers are capability-first: version control, pull request/review, CI/checks, issue tracker, agent runtime, runtime usage, and notification/hook. GitHub through `gh` and Jira through `jtk` are bundled implementations, not domain concepts. Provider-backed actions are disabled or marked unavailable when health is degraded. Hooks use JSON input/output; command hooks run with bounded output, timeouts, cwd/env policy, and operation logging.

## Terminal Runtime

Shell-backed agent runtimes always launch through tmux. Citadel persists tmux session name/id and owns browser attach/reconnect through `packages/terminal`. The browser uses xterm.js for terminal rendering. REST/SSE carry state; WebSocket carries terminal I/O. `ttyd` is a reference/fallback only.

## UI Policy

The UI is an operator cockpit, not a landing page. It must be dense, scannable, responsive, and filtered for product language. It must not show raw implementation notes, prompt text, Jira task wording, raw provider dumps, or OpenClaw-specific labels. Desktop and mobile layouts must be screenshot reviewed before final completion.

## Deployment

The first supported runtime is direct local Linux host install with pnpm, SQLite, tmux, git, and optional shell-backed provider CLIs. MCP is enabled by default for local/internal use and is not designed for public internet exposure in v2. Docker remote agents and daemon/client desktop architecture are later extension paths.

## Engineering Standards

See [v2 engineering standards](../contributors/v2-engineering-standards.md) for package management, tests, coverage, security checks, UI review, and contribution rules.
