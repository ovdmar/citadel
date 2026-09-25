# Citadel v2 Headless Implementation Campaign

You are running a long-lived Codex implementation campaign for Citadel v2.

## Mission

Rebuild Citadel v2 directly on `main` as a production-ready, local-first Linux app for managing repositories, workspaces, tmux-backed agent runtimes, providers, hooks, MCP, and an operator web UI.

This is a headless delivery campaign. Keep working until Citadel v2 is implemented, running locally, verified, and documented, or until a real blocker makes progress impossible or unsafe.

## Source Of Truth

Use Jira epic `MS-471` and child tasks `MS-472` through `MS-497` as the source of truth.

Fetch full task text with:

```bash
/home/linuxbrew/.linuxbrew/bin/jtk issues get MS-496 --fulltext --no-color
/home/linuxbrew/.linuxbrew/bin/jtk issues search 'parent = MS-471 ORDER BY key ASC' --fulltext --no-color
```

`MS-496` is the campaign contract. The other tasks define architecture, domain, UI, runtime, provider, hook, persistence, MCP, testing, security, and hardening acceptance criteria.

## Locked Decisions

- Build v2 directly on `main`.
- Preserve v1 only via branch `v1`, already pushed.
- First campaign scope is local-first Linux host usage only.
- SQLite is the v2 persistence baseline.
- React + Vite + TanStack Router + shadcn UI is the frontend baseline.
- pnpm is required; do not use npm/yarn or introduce npm/yarn lockfiles.
- Biome is the lint/format baseline.
- MCP is enabled by default for local/internal deployments, configurable, and not intended for public internet exposure.
- OpenClaw must not be a core dependency. Do not port the current OpenClaw page.
- Future OpenClaw support must happen via Citadel MCP/API/provider integration.
- Shell-backed agent runtimes always launch through tmux and persist tmux session id/name for reconnect.
- Terminal architecture: tmux durable sessions, Citadel daemon terminal gateway, xterm.js in the browser, WebSocket for bidirectional terminal I/O, REST/SSE for app state/events.
- Browser terminal attach uses real PTY semantics through node-pty `tmux attach-session`; no daemon-managed external renderer fallback is kept.
- Do not interrupt Ovidiu unless blocked by missing credentials, unsafe destructive action, or impossible ambiguity.

## Target Repository Shape

Create an intentional pnpm workspace. Do not preserve the current flat structure by inertia.

```text
citadel/
  apps/
    daemon/
    web/
    cli/
  packages/
    core/
    contracts/
    config/
    db/
    operations/
    terminal/
    runtimes/
    providers/
    hooks/
    mcp/
    ui/
    testing/
  docs/
    architecture/
    operations/
    contributors/
    campaigns/
  scripts/
    checks/
    dev/
  e2e/
  .github/workflows/
  Makefile
  pnpm-workspace.yaml
```

Boundary rules:

- `packages/core` is pure domain/state-machine code and cannot import daemon, web, db, providers, runtimes, hooks, terminal, or MCP implementations.
- `packages/contracts` is the shared API language between daemon, web, and MCP.
- `apps/web` cannot import daemon/server internals.
- Providers and runtimes depend on contracts/config/core concepts, but core never depends on provider/runtime implementations.
- `packages/terminal` owns tmux/WebSocket terminal protocol.
- `packages/db` owns SQLite persistence details.
- `packages/operations` coordinates side-effectful workflows.
- OpenClaw-specific code does not belong in core.

Add static checks enforcing these boundaries.

## Phase Order

Phase 0: repo hygiene and architecture foundation

- Establish pnpm workspace, TypeScript strict mode, path aliases, public package entrypoints, Biome, Makefile, baseline CI/check scripts, architecture boundary checks, file length check, dependency security gates, and implementation log.
- Add docs for architecture and engineering standards before broad feature implementation.

Phase 1: daemon, persistence, config, operations

- Implement daemon foundation.
- Implement SQLite schema/migrations/repositories.
- Implement hybrid config: config file for static defaults/providers/adapters/hooks/repo defaults/command policy; SQLite for mutable app state/workspaces/operations/events/agent sessions/provider health snapshots/UI preferences.
- Implement operation queue, repo/workspace locks, lifecycle events, activity/audit log, health endpoints, REST contracts, and SSE app-state events.

Phase 2: repo/workspace/agent/session domain

- Implement repo registry and workspace model.
- Workspace branches start from latest remote default branch.
- If an issue key is provided at workspace creation, branch name starts with issue key and dashified issue title when provider metadata is available.
- Repo-level workspace setup/teardown hooks.
- Workspace removal fails when workspace git status is dirty unless explicit force policy is implemented and logged.
- Multiple agent sessions per workspace, potentially using different runtimes.
- Agent creation lets the user pick from installed/available configured runtimes.
- All shell-backed runtimes run in tmux with persisted tmux identity.

Phase 3: providers, hooks, MCP, terminal gateway

- Capability-first provider model:
  - version-control provider
  - PR/review provider
  - CI/checks provider
  - issue-tracker provider
  - agent-runtime provider
  - runtime-usage provider
  - notification/hook providers
- GitHub via `gh` is the default bundled version-control/PR/CI implementation.
- Jira via `jtk` is the default bundled issue-tracker implementation.
- Provider-dependent features must be disabled/unavailable when provider health is failing.
- CI provider must expose list of checks, statuses, and logs in provider-agnostic terms.
- Usage providers are runtime-scoped, one per agent runtime where available.
- Codex on Linux may require a simplified codexbar-like usage implementation or explicit unsupported state with follow-up.
- Hook model supports bash/command first and future hook types such as webhook, MCP call, launch-agent.
- Hook input/output is JSON.
- MCP tools/resources expose normalized Citadel concepts and are enabled by default for local/internal use.
- Terminal gateway supports interactive CLI fidelity.

Phase 4: operator UI

- Build the actual operator cockpit, not a landing page.
- UI must be dense, scannable, operational, and product-filtered.
- No raw implementation instructions, prompt wording, raw enum names, provider debug dumps, Jira task language, OpenClaw-specific labels, or planning metadata may leak into visible UI.
- Current OpenClaw page must not be ported.
- Implement workspace list/detail, agent sessions, terminal panes, operations, provider health, settings, usage, diff viewer, activity, and MCP/status visibility.
- Implement light/dark/system theme.
- Mobile must support monitoring/navigation/light actions without broken layout.
- Performance target: roughly 10-12 active workspaces per repo, multiple sessions, long terminal buffers, instant-feeling workspace switching, responsive terminal scrolling.
- Do not render huge terminal scrollback as ordinary React DOM.

Phase 5: hardening, verification, docs

- High code coverage gate: core/backend/shared/domain target at least 90% line/statement coverage, with meaningful branch/path tests for critical safety/domain modules. Any lower threshold must be documented in the implementation log with rationale.
- Unit/integration tests for domain, operation queue, DB/migrations, provider health, workspace safety, tmux session tracking, terminal gateway, API contracts.
- Playwright e2e for basic happy paths:
  - configured state or first-run settings
  - repo/workspace flow with safe test repos/mocks
  - agent runtime creation/selection with safe fake shell runtime
  - provider degraded state
  - terminal smoke: type, output, resize, paste, switch away/back
  - desktop and mobile layout checks
- Dependency security:
  - block unapproved lifecycle/build scripts by default
  - dependency scan/review before adding packages
  - known vulnerability/malware check
  - lockfile changes treated as security-sensitive
- Performance smoke for workspace switching and terminal scrolling.
- Startup smoke, migrations check, build, lint/format, typecheck, tests, coverage, e2e where practical.
- Final docs: architecture, install/run, config, provider setup, hooks, MCP, terminal/runtime behavior, contributor checks.

## Interactive Terminal Fidelity Gate

Terminal work is not done unless embedded interactive CLI runtimes work with local-like behavior.

Required:

- raw key input
- ctrl/meta sequences
- paste behavior
- resize events
- prompt redraws
- alternate screen behavior where supported
- long output streaming
- reconnect to same tmux session
- cross-session output isolation
- responsive typing and scrolling under normal local usage

Do not claim completion based only on static terminal rendering or one-shot command output.

## Subagent Guidance

Use targeted subagents when they materially help and the work can be bounded.

Good subagent scopes:

- architecture/checks review
- provider/API contract implementation slice
- terminal gateway review
- UI screenshot/performance review
- test-gap review
- isolated package implementation

Each subagent must have clear deliverables, relevant Jira tasks, expected output, and file/module ownership. Do not use vague brainstorm subagents. Do not let subagents make architecture decisions that contradict this campaign contract.

## Implementation Discipline

- Keep a running implementation log in the repo under `docs/campaigns/`.
- Make logical, reviewable commits during implementation.
- Do not revert unrelated user changes.
- Do not use destructive git commands.
- Prefer existing code only when it fits v2 architecture; do not cargo-cult current structure.
- Do not preserve compatibility with unshipped v1 internals unless required by an explicit task.
- Fail loudly on broken assumptions. Avoid silent fallbacks.
- If provider health is bad, disable/degrade provider-backed features clearly.

## Final Definition Of Done

The campaign is complete only when:

- Citadel v2 is implemented on `main`.
- App starts locally.
- Local run URL/instructions are documented.
- Core smoke path works: configure repo, create workspace, start safe agent runtime, view status/events, inspect provider health, open terminal, MCP can inspect status.
- `make check` or documented equivalent passes, including typecheck, Biome, tests, coverage, dependency security, architecture checks, migrations, startup smoke, build, and practical e2e/performance checks.
- Playwright happy-path e2e exists and passes or any unavoidable CI limitation is documented with a local command.
- Desktop/mobile screenshots are captured/reviewed for key views.
- Implementation log records final verification.
- No OpenClaw page or core OpenClaw coupling remains.
- Final report includes commits, commands run, known limitations, and exact run instructions.

## Blocker Protocol

Do not ask Ovidiu questions during the run unless:

- missing credentials make required verification impossible,
- an action would be unsafe/destructive beyond the agreed rebuild,
- a material ambiguity cannot be resolved from Jira/repo context and guessing would risk the architecture.

For everything else, choose conservatively, document the decision in the implementation log, and continue.
