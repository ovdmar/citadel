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
[ ] 2. Workspace — a feature/task container with a durable root directory, mode (`freestyle` or `structured`), lifecycle, optional parent issue binding, plan history, manager state, and an unremovable Home execution target.
[ ] 3. Workspace Home — the execution target rooted at the workspace root. PM, architect, and manager sessions run here. Home can exist before any repository checkout is known.
[ ] 4. Worktree checkout — a repository worktree under a workspace root. One checkout represents one branch and one intended PR, may bind to one child issue, and may participate in a stack.
[ ] 5. Execution target — either Workspace Home or a worktree checkout. Every terminal or agent session launches in exactly one target cwd.
[ ] 6. Workspace session — a durable tab/session attached to an execution target. Workspace sessions are either agent sessions or terminal sessions.
[ ] 7. Agent session — a workspace session with `kind: "agent"` launched by an agent runtime, optionally tied to a role template, action template, manager action, parent session, and workspace plan version.
[ ] 8. Agent runtime — a prompt-driven CLI agent integration such as Claude Code, Codex, Cursor Agent, Pi, or another configured adapter.
[ ] 9. Role template — one of Citadel's five predefined non-deletable roles: `pm`, `architect`, `implementation`, `prototype`, and `manager`. A role stores a system prompt and semantic launch settings.
[ ] 10. Action template — a built-in role-owned action such as `implementation.review_pr` or `manager.heartbeat_digest`, with prompt and launch settings. V1 does not include arbitrary user-defined triggers.
[ ] 11. Launch settings — semantic runtime selection fields: runtime id, model id, effort/reasoning level, fast mode, and context mode. Runtime adapters map these settings to concrete argv and record warnings when unsupported or invalid settings fall back.
[ ] 12. Manager instance — the durable workspace supervisor state machine. Structured workspaces get one manager at creation; freestyle workspaces may opt into one manually.
[ ] 13. Workspace plan version — a registered reviewed plan artifact with an autoincrement version, status, hash, review artifacts, decisions, and at most one approved active version per workspace.
[ ] 14. Delivery unit — a machine-readable slice of an approved plan that binds a stable key to repo/checkout/branch intent, child issue identity, dependency edges, and manager sequencing rules.
[ ] 15. Manager action ledger — the durable leased claim table for manager-owned side effects. It dedupes repeated event/tick wakeups by stable scope/action/fact keys and records lease fencing, attempts, related side effects, completion, failure, supersession, and abandonment.
[ ] 16. Review artifact — a durable `review-pr` result tied to checkout, PR head SHA, active plan version, findings status, timestamp, invalidation state, and any human waiver decision.
[ ] 17. Implementation gate — checkout readiness derived from PR existence, checks, conflicts, current review artifact, plan version, deviation reports, provider freshness, and stack state.
[ ] 18. Provider fact — durable provider-backed issue, PR, check, or mergeability data with provider instance/account identity, source binding, freshness, stale/degraded state, and collision-safe external identifiers.
[ ] 19. Local notification event — an in-app/browser/sound notification fact for ready-for-human-review or human-input-needed conditions, with active/resolved/rearmed lifecycle and a dedupe key.
[ ] 20. Agent tool authority — a server-minted, session-scoped permission record that lets managed agent sessions call only the MCP/API tools allowed for their role/action/checkout/plan/manager action.
[ ] 21. Provider — an integration that normalizes external system data into Citadel contracts.
[ ] 22. Hook — a repo-scoped extension command or agent prompt that returns structured data or executes structured actions.
[ ] 23. Operation — a tracked long-running or side-effectful action with status, progress, logs, and activity.
[ ] 24. Readiness — Citadel's operator-facing summary of what needs attention and why.
[ ] 25. Link — a navigation target related to a repo, workspace, provider, application, issue, PR, operation, or artifact.
[ ] 26. Action — an explicit command the operator or manager can trigger through Citadel.

## Status Legend

[x] 1. Shipped behavior.
[~] 2. Partially shipped behavior that needs hardening.
[ ] 3. Target behavior.

---

keywords: citadel, ade, cockpit, repository, workspace, workspace session, agent session, agent runtime, terminal profile, provider, hook, operation, readiness, delivery unit, manager action ledger
