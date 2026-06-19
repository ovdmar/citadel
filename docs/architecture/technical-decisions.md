# Technical Decisions

This page records the high-level engineering choices behind Citadel. It is written for reviewers who want to understand the shape of the system before reading implementation details.

## Local-First Daemon And Browser UI

Citadel runs as a local daemon with a browser cockpit because the work it coordinates is already local: git repositories, worktrees, provider CLIs, terminal sessions, hooks, and agent runtimes. A hosted service would need broad access to a developer's filesystem and credentials; a local daemon keeps that authority on the operator's machine.

The browser UI stays thin. It renders state, sends commands, and attaches to terminal streams. Filesystem access, process management, provider calls, hooks, persistence, and terminal ownership remain in the daemon and packages below it.

## SQLite Persistence

SQLite is the mutable state baseline. It is enough for a single-operator workbench, easy to back up, and inspectable when debugging. The database stores repositories, workspaces, sessions, operations, activity, provider snapshots, review artifacts, UI preferences, and runtime state.

Migrations are forward-only in practice. Rollback is backup/restore, not a second migration system.

## Typed Contracts Between Web And Daemon

`packages/contracts` owns request, response, and event DTOs with Zod schemas. The web app imports contracts, not daemon internals. That keeps browser code honest and lets API changes fail at compile/test time instead of drifting silently.

The package boundary also makes tests cheaper: browser tests can validate UI behavior against typed data shapes without importing the server.

## Durable Terminal Sessions

Agent work often runs for longer than a browser tab. Citadel therefore treats sessions as durable workspace resources, not React component state.

Legacy sessions use tmux identity so a browser refresh kills only the viewer, not the work. PTY-daemon work extends that model by giving long-running PTY ownership to a dedicated local process and using the daemon as the bridge for cockpit attach/reconnect.

The browser renders with xterm.js over a dedicated WebSocket. REST and SSE carry app state; terminal bytes use the terminal channel.

## Provider Adapters Instead Of Provider-Specific Product Model

GitHub, Jira, and other tools appear as provider implementations behind normalized concepts: version control, pull requests, checks, issue tracking, usage, and notifications.

This keeps the cockpit generic. A provider can expose branded links or icons, but workspace state should not depend on a single provider's terminology or API shape.

## Hooks As Extension Points

Repository hooks let projects attach deploy links, preview apps, notifications, and custom actions without baking one workflow into Citadel. Hooks receive JSON input, run with bounded output and timeouts, and return structured metadata that can be shown on activity and workspace surfaces.

Hook files are privileged code. They are reviewed like source code because they execute on operator machines.

## Architecture Gates

Citadel uses code checks to preserve the architecture:

- `check:arch` enforces package boundaries.
- `check:size` keeps large modules from becoming unreviewable.
- TypeScript project references force package-level compile hygiene.
- Dependency policy blocks unexpected package-manager drift and reviews sensitive dependency changes.
- Vitest and Playwright cover domain logic, daemon behavior, UI surfaces, and end-to-end operator flows.

The goal is not just green CI. The checks encode the same boundaries described in the architecture docs so the codebase stays understandable as it grows.
