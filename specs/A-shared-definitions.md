# [A] Shared Definitions

**Status:** Draft

> Shared product language used across Citadel specs.

## Product Identity

[ ] 1. Citadel is an ADE cockpit for managing async AI engineering work.
[ ] 2. Citadel is repo-agnostic and workflow-agnostic at the core.
[ ] 3. Citadel models external systems through providers, hooks, and links.
[ ] 4. Citadel is local-first and daemon-backed.
[ ] 5. Web UI, future desktop app, CLI, and MCP use the same daemon product boundary.
[ ] 6. Citadel presents operator state in product language rather than implementation language.

## Core Terms

[ ] 1. Repository — a configured source repository with stable identity, provider settings, hooks, and workspace defaults.
[ ] 2. Workspace — a tracked git worktree inside a repository, with stable identity independent of path/name.
[ ] 3. Agent session — a durable agent/runtime session attached to a workspace.
[ ] 4. Runtime adapter — a CLI agent integration such as Claude, Codex, Pi, or another configured shell-backed agent.
[ ] 5. Provider — an integration that normalizes external system data into Citadel contracts.
[ ] 6. Hook — a repo-scoped extension command or agent prompt that returns structured data or executes structured actions.
[ ] 7. Operation — a tracked long-running or side-effectful action with status, progress, logs, and activity.
[ ] 8. Readiness — Citadel's operator-facing summary of what needs attention and why.
[ ] 9. Link — a navigation target related to a repo, workspace, provider, application, issue, PR, or operation.
[ ] 10. Action — an explicit command the operator can trigger through Citadel.

## Status Legend

[x] 1. Shipped behavior.
[~] 2. Partially shipped behavior that needs hardening.
[ ] 3. Target behavior.

---

keywords: citadel, ade, cockpit, repository, workspace, agent session, runtime, provider, hook, operation, readiness
