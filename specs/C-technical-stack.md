# [C] Technical Stack And Architecture Guardrails

**Status:** Draft

> Approved implementation baseline for Citadel. Product specs define what Citadel does; this file defines the stack and architecture future agents should preserve.

## Runtime Baseline

[~] 1. Citadel is a TypeScript monorepo.
[~] 2. Citadel uses pnpm workspaces.
[~] 3. Citadel targets Node.js 24+.
[~] 4. Citadel uses ESM modules.
[ ] 5. The first supported runtime is direct local Linux host install.
[~] 6. Required local tools are git and tmux. Browser terminal attach uses the in-process daemon bridge plus the native `node-pty` dependency; no separate terminal renderer binary is required.
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
[~] 5. The web app renders interactive terminals with xterm.js over the daemon WebSocket at `/terminal/:sessionId`. It does not mount terminal iframes during normal cockpit navigation.
[~] 6. The web app uses lucide-react for icons.
[~] 7. shadcn-style UI is built with local components, Radix primitives where useful, class-variance-authority, clsx, tailwind-merge, and Tailwind CSS.
[ ] 8. Shared UI components live in packages/ui only when reuse is real.
[ ] 9. Frontend code imports shared contracts and typed clients, not daemon internals.

## Backend And API Stack

[~] 1. The daemon uses Express for HTTP APIs.
[~] 2. The daemon uses REST for commands and snapshots.
[~] 3. The daemon uses SSE for app-state/events.
[~] 4. The daemon serves interactive terminal I/O through `/terminal/:sessionId` WebSocket upgrades backed by node-pty running `tmux attach-session`. Terminal bytes move as binary frames; JSON is used for control messages.
[~] 5. The daemon uses Zod-backed contracts for shared request/response/event schemas.
[ ] 6. Long-running or side-effectful work is represented as operations.
[ ] 7. Terminal transport remains separate from app-state transport.
[ ] 8. Provider, hook, runtime, operation, terminal, and MCP boundaries remain package-level concepts.

## Persistence And Config

[~] 1. SQLite is the mutable local state baseline.
[ ] 2. SQLite owns repositories, workspace roots, workspace checkouts, operations, activity, workspace sessions, provider health snapshots, plan versions, manager state/events, review artifacts, UI preferences, and runtime state.
[ ] 3. Config files own static defaults, providers, runtime definitions, terminal profile, hooks, repo defaults, command policy, and may own editable predefined role/action templates when boot-safe. DB-backed template storage is also acceptable.
[ ] 4. Migrations are forward-only for the initial local-first baseline.
[ ] 5. Backup/restore is the rollback strategy for local data.
[ ] 6. Workspace schema migration is append-only in spirit: add `workspaces.root_path`/`mode`, keep `workspaces.path` as legacy primary-checkout compatibility until all callers use typed accessors, and create child tables for checkouts/plans/managers/review artifacts.
[ ] 7. Manager orchestration schema additions are append-only in spirit: delivery-unit snapshots, dependency edges, manager action ledger, durable issue facts, transition attempts, durable checkout PR/check facts, agent tool authorities, review invalidation/waiver fields, and checkout delivery-unit identity are additive migrations with nullable compatibility for existing workspaces.

## Terminal And Runtime Stack

[~] 1. Agent runtimes launch through tmux using the configured terminal profile as the base shell.
[~] 2. Citadel persists tmux session identity.
[~] 3. Browser attach/reconnect is owned by packages/terminal: the xterm/WebSocket bridge uses node-pty `tmux attach-session` at `/terminal/:sessionId`.
[~] 4. Browser terminal traffic is scoped by session ID through `/terminal/:sessionId` WebSocket upgrades; there is no daemon-managed per-session terminal renderer process or secondary proxy route.
[~] 5. The cockpit shows an explicit, actionable error (`session_not_found`, `tmux_session_missing`, `terminal_unavailable`, `spawn_failed`) when a terminal cannot be served — never a blank black surface.
[ ] 6. Agent runtime adapters live behind capability-based contracts.
[ ] 7. Runtime health is visible before session start.
[~] 8. Trade-offs of using xterm.js over node-pty/tmux attach are accepted: Citadel owns the bridge, but preserves real PTY semantics while avoiding per-session external renderer processes for normal navigation.

## Package Boundaries

[~] 1. packages/core contains pure domain/state-machine code.
[~] 2. packages/contracts contains shared Zod schemas and API/event DTOs.
[~] 3. packages/config contains versioned config loading and validation.
[~] 4. packages/db contains SQLite schema, migrations, repositories, and transaction helpers.
[~] 5. packages/operations contains side-effectful workflows.
[~] 6. packages/terminal contains the tmux gateway, node-pty WebSocket bridge, input helpers, capture utilities, and pane/log lifecycle helpers.
[~] 7. packages/runtimes contains agent runtime provider contracts and adapters.
[~] 8. packages/providers contains version-control, PR, CI, issue tracker, usage, and notification providers.
[~] 9. packages/hooks contains hook contracts, command execution, and event dispatch.
[~] 10. packages/mcp contains MCP tools/resources over normalized Citadel concepts.
[~] 11. packages/testing contains fixtures, fake providers/runtimes, and e2e helpers.
[ ] 12. Workspace and checkout path helpers expose typed accessors (`workspaceRootPath`, `checkoutPath`, `executionTargetCwd`) so callers do not reinterpret legacy `workspaces.path`.
[ ] 13. Manager reducers, gate reducers, stack planners, and migration planners live in pure packages where practical; daemon route/MCP modules wire them to persistence, providers, terminal, and operations.
[ ] 14. Plan parsing, gate derivation, stack planning, structured launch-option derivation, and manager decision reducers are pure logic. They do not import filesystem, process, HTTP, React, DB, providers, terminal, daemon, or MCP modules.
[ ] 15. apps/web consumes daemon-provided structured state and shared contracts/core helpers only. It does not duplicate daemon launch preconditions or import daemon internals.

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

## Distribution

[ ] 1. Citadel ships as a versioned source checkout, not a published binary or package — the systemd unit references `apps/daemon/dist/index.js` directly out of the install root.
[ ] 2. Versions are pinned via annotated git tags shaped `v<major>.<minor>.<patch>`. Lightweight tags, arbitrary branches, and SHAs are not valid install targets.
[ ] 3. `make install` and `make upgrade` default to the latest stable annotated `vX.Y.Z` tag advertised by `origin`, sorted numerically and ignoring malformed/prerelease tags. Default resolution requires network access and never trusts local-only tags.
[ ] 4. `make install REF=main` and `make upgrade REF=main` fetch and check out exactly `origin/main` for development/bootstrap installs. `make install REF=vX.Y.Z` and `make upgrade REF=vX.Y.Z` install the exact annotated tag, using a local annotated tag only when the best-effort origin tag fetch fails. Any other `REF` is rejected.
[ ] 4a. `make install` is self-contained after `git clone`: resolve ref, run `pnpm install --frozen-lockfile`, build, write systemd units, restart, then verify with `make doctor`. `make upgrade` is the same behavior with clearer operator wording.
[ ] 5. Both install and upgrade refuse to run from a checkout whose path differs from the `WorkingDirectory=` line of the installed `~/.config/systemd/user/citadel.service`.
[ ] 6. Each tag pushed to GitHub triggers `.github/workflows/release.yml`, which runs `make check` *before* `gh release create`. A failing check blocks release publication; the operator deletes the tag (`git push --delete origin v<x.y.z>`) and re-cuts after fixing.
[ ] 7. `CHANGELOG.md` is reverse-chronological; each release lists what changed plus a "Known gaps" section for deferred items.

## HTTP And HTTPS

[ ] 1. The daemon binds plain HTTP on `127.0.0.1` by default. This is the supported, encouraged configuration for local-first use.
[ ] 2. Operators can opt into HTTPS by setting `config.tls = { certPath, keyPath }`. Both paths must be absolute, both files must exist and be non-zero bytes, and the cert must not be expired. Validation runs at daemon boot — misconfiguration causes a fail-fast exit, not a runtime crash.
[ ] 3. Citadel is *not* a reverse-proxy replacement. HTTPS is in-process and intended for operators who explicitly bind a non-loopback host (LAN exposure, Tailscale, etc.) or want to test TLS locally via mkcert.
[ ] 4. The doctor and the boot log warn when `bindHost` is non-loopback AND `config.tls` is absent — never the inverse (mkcert + 127.0.0.1 is a normal pattern).
[ ] 5. WebSocket transports (terminal proxy, diagnostic gateway) function identically over `wss://` when TLS is active.

---

keywords: tech stack, architecture, typescript, pnpm, node, react, vite, tanstack, express, sqlite, tmux, node-pty, xterm, websocket, sse, zod, biome, vitest, playwright
