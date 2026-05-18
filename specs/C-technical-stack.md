# [C] Technical Stack And Architecture Guardrails

**Status:** Draft

> Approved implementation baseline for Citadel. Product specs define what Citadel does; this file defines the stack and architecture future agents should preserve.

## Runtime Baseline

[~] 1. Citadel is a TypeScript monorepo.
[~] 2. Citadel uses pnpm workspaces.
[~] 3. Citadel targets Node.js 24+.
[~] 4. Citadel uses ESM modules.
[ ] 5. The first supported runtime is direct local Linux host install.
[ ] 6. Required local tools are git and tmux.
[ ] 7. Optional shell-backed providers rely on their own installed CLIs and auth.

## Applications

[~] 1. apps/daemon is the local Citadel daemon.
[~] 2. apps/web is the browser operator cockpit.
[~] 3. apps/cli is reserved for thin local helpers.
[ ] 4. The daemon is the owner of filesystem, git, tmux, operations, providers, hooks, persistence, terminal routing, and MCP.
[ ] 5. The web app is a client over typed contracts and daemon APIs.
[ ] 6. Future desktop, CLI, and MCP clients use the same daemon product boundary.

## Frontend Stack

[~] 1. The web app uses React.
[~] 2. The web app uses Vite.
[~] 3. The web app uses TanStack Router for routing.
[~] 4. The web app uses TanStack Query for server state.
[~] 5. The web app uses xterm.js for terminal rendering.
[~] 6. The web app uses lucide-react for icons.
[~] 7. shadcn-style UI is built with local components, Radix primitives where useful, class-variance-authority, clsx, tailwind-merge, and Tailwind CSS.
[ ] 8. Shared UI components live in packages/ui only when reuse is real.
[ ] 9. Frontend code imports shared contracts and typed clients, not daemon internals.

## Backend And API Stack

[~] 1. The daemon uses Express for HTTP APIs.
[~] 2. The daemon uses REST for commands and snapshots.
[~] 3. The daemon uses SSE for app-state/events.
[~] 4. The daemon uses WebSocket for interactive terminal I/O.
[~] 5. The daemon uses Zod-backed contracts for shared request/response/event schemas.
[ ] 6. Long-running or side-effectful work is represented as operations.
[ ] 7. Terminal transport remains separate from app-state transport.
[ ] 8. Provider, hook, runtime, operation, terminal, and MCP boundaries remain package-level concepts.

## Persistence And Config

[~] 1. SQLite is the mutable local state baseline.
[ ] 2. SQLite owns repositories, workspaces, operations, activity, sessions, provider health snapshots, UI preferences, and runtime state.
[ ] 3. Config files own static defaults, providers, runtimes, hooks, repo defaults, and command policy.
[ ] 4. Migrations are forward-only for the initial local-first baseline.
[ ] 5. Backup/restore is the rollback strategy for local data.

## Terminal And Runtime Stack

[~] 1. Agent runtimes launch through tmux.
[~] 2. Citadel persists tmux session identity.
[~] 3. Browser attach/reconnect is owned by packages/terminal.
[~] 4. Terminal WebSocket traffic is scoped by session ID.
[ ] 5. Reconnect provides a bounded visible snapshot plus live incremental output.
[ ] 6. Runtime adapters live behind capability-based contracts.
[ ] 7. Runtime health is visible before session start.

## Package Boundaries

[~] 1. packages/core contains pure domain/state-machine code.
[~] 2. packages/contracts contains shared Zod schemas and API/event DTOs.
[~] 3. packages/config contains versioned config loading and validation.
[~] 4. packages/db contains SQLite schema, migrations, repositories, and transaction helpers.
[~] 5. packages/operations contains side-effectful workflows.
[~] 6. packages/terminal contains tmux gateway and terminal WebSocket protocol.
[~] 7. packages/runtimes contains agent runtime provider contracts and adapters.
[~] 8. packages/providers contains version-control, PR, CI, issue tracker, usage, and notification providers.
[~] 9. packages/hooks contains hook contracts, command execution, and event dispatch.
[~] 10. packages/mcp contains MCP tools/resources over normalized Citadel concepts.
[~] 11. packages/testing contains fixtures, fake providers/runtimes, and e2e helpers.

## Provider And Hook Stack

[ ] 1. Providers are capability-first implementations behind normalized contracts.
[ ] 2. GitHub provider can use gh for shell-backed auth and data.
[ ] 3. Jira provider can use shell-backed Jira tooling for auth and data.
[ ] 4. Usage providers are provider/hook based.
[ ] 5. Hooks use structured JSON input and output.
[ ] 6. Command hooks run with explicit cwd/env, timeout, bounded output, and operation logging.
[ ] 7. Provider-backed features expose health and stale/degraded state.

## Checks And Tooling

[~] 1. TypeScript stays strict with project references.
[~] 2. Biome is the formatter and linter.
[~] 3. Vitest is the unit/integration test runner.
[~] 4. Playwright is the e2e test runner.
[~] 5. Vite builds the web app.
[~] 6. make check is the release-readiness gate.
[ ] 7. make check includes architecture boundaries, file size checks, typecheck, lint, tests, coverage, dependency policy, and production build.
[ ] 8. Performance smoke remains part of release confidence for the ADE cockpit.

## Dependency Policy

[ ] 1. New runtime dependencies need clear product value.
[ ] 2. Lockfile changes are reviewed as security-sensitive.
[ ] 3. Package lifecycle scripts are reviewed before dependency adoption.
[ ] 4. Existing stack choices are extended before introducing parallel frameworks.
[ ] 5. Framework swaps require explicit product/architecture approval.

---

keywords: tech stack, architecture, typescript, pnpm, node, react, vite, tanstack, express, sqlite, tmux, xterm, websocket, sse, zod, biome, vitest, playwright
