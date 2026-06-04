Activate the /implement-task skill first.

# Plan: Agents, Structured Workspaces, And Manager Orchestration

## Supersession

This plan supersedes the previous `.agents/plans/agents-system.md` direction and the current `agent/12-agents-system-6haz23` implementation slice. The current branch may be used as reference material only after deliberate review; implementation should start from a clean branch, recommended `fb-agents-orchestration-v2`, because the existing code leans into custom agents, single-repo workspace assumptions, and local-only handoff primitives that no longer match the product direction.

The opening line is retained because Citadel's `/implement-task` handoff convention requires it. The implementation session must still start with the specs-first steps in this plan, not by writing production code immediately.

## Acceptance Criteria

- [ ] Citadel supports two workspace modes: freestyle workspaces for today-style manual work and structured workspaces for automated feature delivery.
- [ ] A structured workspace is a feature container with a real root directory, an unremovable `Home` execution target, zero or more worktree checkouts, and an optional external parent issue binding.
- [ ] New structured workspaces can start with zero checkouts so PM, architect, and manager work can happen before the affected repos are known. Prototype is checkout-scoped and can start only after the user/plan creates a repository checkout for prototyping.
- [ ] A structured workspace may remain provider-less during discovery/prototype/architecture, but structured implementation cannot begin until a parent issue and child ticket bindings exist. Provider-less coding remains freestyle, not structured.
- [ ] Worktree checkouts live under the workspace root directory. Multiple checkouts may point at the same repository, and Citadel models one checkout as one branch and one intended PR.
- [ ] Existing single-repo workspaces migrate automatically once to the root + checkout layout when safety checks pass. Dirty worktrees are migrated too, but dirty files must not be lost.
- [ ] Workspace `Home` and worktree checkouts are first-class execution targets. Home-scoped sessions run at the workspace root; checkout-scoped sessions run inside the checkout.
- [ ] The navigator evolves to show workspaces as top-level rows with `Home` and checkout children. Each target has its own live tabs/chats.
- [ ] Closing a tab kills the tmux session, but the durable agent-session history keeps runtime session id, role/action metadata, artifacts, and resume information.
- [ ] Workspace-level agent history is visible across Home and all checkouts so many manager-created sessions can be inspected or resumed without keeping every tab open.
- [ ] Global Agents nav is configuration only: it edits predefined role templates and their built-in action templates. Workspace-specific manager state/history lives inside the workspace.
- [ ] V1 ships exactly five predefined roles: `pm`, `architect`, `implementation`, `prototype`, and `manager`.
- [ ] Predefined roles are non-deletable, editable, and resettable to Citadel defaults. Custom agents, custom CRUD, `list_custom_agents`, and `launch_custom_agent` are out of scope for v1.
- [ ] Role templates store system prompt plus launch settings: runtime id, model id, reasoning/thinking effort where supported, fast mode where supported, and max-context mode where supported.
- [ ] Built-in action templates belong to roles, not to a global trigger builder. Actions have editable prompt/runtime/model/effort/fast/context settings and reset-to-defaults.
- [ ] V1 ships built-in triggers/actions only. Users cannot define arbitrary triggers in v1.
- [ ] Runtime model and option discovery is available from day one. If a configured model or option becomes invalid, launch falls back to the runtime default and records a warning.
- [ ] Runtime launch supports runtime-specific model/effort/fast/context arguments through configurable arg mapping plus runtime adapters, not prompt-only metadata.
- [ ] Manual launch UI offers specialized predefined roles where valid and freestyle empty runtime sessions separately. Specialized sessions are manager-tracked by default; freestyle runtime sessions are not manager-tracked.
- [ ] Role target rules are enforced by UI and MCP: `pm`, `architect`, and `manager` run on Home; `implementation` and `prototype` run on checkouts.
- [ ] `launch_pm_agent` can bootstrap a structured workspace shell from an idea or external parent issue without requiring a repo or checkout first.
- [ ] `launch_architect_agent` requires an existing structured workspace Home, discovery marked ready by the human, and a selected `planApprovalMode` (`manual` or `auto`).
- [ ] In structured mode, specialized implementation launch is blocked until a final active workspace plan exists, the workspace has a parent issue binding, and the target checkout/delivery unit has exactly one child ticket binding. Freestyle runtime launches remain available separately.
- [ ] Prototype can run before the workspace plan is ready, but only inside a worktree checkout. Prototype checkouts are discovery/design evidence and do not satisfy implementation delivery gates.
- [ ] Every structured workspace gets one manager instance at creation. It starts mostly no-op and becomes active as lifecycle state advances. Freestyle workspaces may opt into a manager manually.
- [ ] Manager automation can be paused globally and per workspace. Pause stops manager/agent-triggered automated actions but does not block human manual launches or important local notifications. Manual specialized launches while paused are tracked, but manager follow-up waits until automation is unpaused.
- [ ] Manager heartbeat is event-first with a configurable periodic tick backstop.
- [ ] Manager runs at workspace Home, has Citadel MCP access, and can call tools directly. Invariants and safety checks live in MCP tool implementations.
- [ ] Manager automation is idempotent: one manager per workspace, deduped active actions per scope/action key, one checkout per planned delivery unit, and one review gate result per checkout/head/plan.
- [ ] Structured workspace lifecycle is explicit: discovery inputs, architecture, optional plan review/approval, implementation, ready for human review, done.
- [ ] Discovery inputs can come from PM, prototype, both, human-written PRD, external issue text, or provider artifacts. Only the human marks discovery ready and launches architecture.
- [ ] PM-to-architect handoff is first-class and records discovery context, `planApprovalMode`, and expected plan artifact requirements.
- [ ] Architect plans use `/do-tech-plan` as the base format and add manager-readable delivery sections.
- [ ] Architect completion requires registering a final reviewed workspace plan artifact. An idle architect session without plan registration is incomplete.
- [ ] Architect plan creation runs `review-tech-plan`.
- [ ] Workspace plans are versioned per workspace with Citadel-generated autoincrement versions. All versions, review artifacts, and decisions remain inspectable.
- [ ] Exactly one approved active workspace plan version drives manager automation. New approved versions supersede older active versions.
- [ ] When a new active plan version appears during implementation, manager notifies all active implementation agents so they adapt.
- [ ] Implementation agents can report plan deviations through a structured MCP tool. Manager pauses affected delivery units when possible, otherwise all, then can launch architect replan. Replans use the workspace's existing approval policy.
- [ ] Architect plans include required sections for delivery units, dependencies/timeline, branch strategy, and manager handoff.
- [ ] Structured implementation checkouts require a child ticket binding. The ticket provider is abstract; Jira is one provider, but the model must allow GitHub Issues or Linear later. A workspace uses one ticket provider, not mixed providers.
- [ ] Citadel reads parent/child ticket planning content live from the issue provider. Citadel stores local execution bindings and prompt snapshots, not local-only work items.
- [ ] Architect agents create/update external child tickets through provider tools; Citadel binds checkouts to those existing external tickets.
- [ ] Manager creates/selects implementation checkouts from the active plan, binds each checkout to one child ticket, and launches implementation agents according to dependencies. If any planned implementation unit cannot be bound to exactly one child ticket, manager pauses that unit and asks for human/provider correction.
- [ ] Dependency edge types distinguish parallel work, stacked PR work, true wait-for-merge/release work, and manual checkpoints.
- [ ] For same-repo stacked work, downstream checkouts start from upstream branch/head by default after upstream CI is green and `review-pr` has passed.
- [ ] Manager owns stack orchestration and automatic restacking in v1. Base branch updates and upstream PR changes cascade through the stack from bottom to top.
- [ ] Implementation agents must explicitly signal completion through a tool once they believe PR exists and checks are green. Manager independently verifies gates.
- [ ] Readiness for each implementation checkout requires PR exists, checks green, no conflicts, current head SHA reviewed by `review-pr`, no unresolved blocking review findings unless explicitly waived by a human, and no invalidated plan/review state.
- [ ] `review-pr` is a built-in action under the implementation role, always launched in a separate session. Its artifact is required before an implementation checkout is ready for human review.
- [ ] Review artifacts are versioned per checkout/PR with PR head SHA, active plan version, result, findings status, and timestamp.
- [ ] Any PR head SHA change invalidates the previous review artifact and manager re-runs `review-pr` once PR is green/no-conflict again.
- [ ] Manager continues tracking PR conflicts until PR merge. If conflicts appear later, readiness is revoked and fix/restack automation runs when unpaused.
- [ ] Manager updates external ticket execution status best-effort by asking provider tools/agents to move tickets to internal states such as in progress, in QA, in review, or done. Delivery does not block on failed ticket transitions.
- [ ] V1 human notifications are local only: in-app activity/alert plus optional browser/PWA desktop notification and sound. Slack/Teams/external notification connectors are deferred.
- [ ] MCP context tools accept `cwd` but only resolve paths inside Citadel-registered workspace roots or checkouts; otherwise they return an error.
- [ ] Out of scope for v1: custom agents, arbitrary user-defined triggers, Slack/Teams/external notifications, mixed issue providers in one workspace, local-only work items, full "join existing epic from another user's Citadel" flow, and manual checkout-purpose selection.

## Context and Problem Statement

Citadel currently models a workspace as a single git worktree attached to one repository. That is too narrow for the agent workflow we want:

- A feature may start with no repo context while PM discovery and architecture are still happening. Prototype is still part of discovery, but it requires a chosen repo checkout because prototype agents are checkout-scoped.
- A feature may later require several repositories, or several independent/stacked branches in the same monorepo.
- PM, architect, manager, implementation, prototype, review, CI-fix, conflict-fix, and restack work need different runtimes/models and different scopes.
- A manager agent is the core value proposition, but it needs Citadel-owned durable state instead of being a plain one-off chat.
- Handoff must be reliable across many short-lived agent sessions so Citadel can use cheaper/faster models for smaller steps without losing auditability.

The existing branch started by adding reusable agent definitions, custom agents, MCP launchers, model listing, and local plan registration. Grilling changed the product direction. The correct v1 is not a generic custom-agent registry; it is a structured automation model around five predefined roles, workspace Home/checkouts, manager orchestration, plan versions, PR gates, and role-owned actions.

## Spec Alignment

This change is cross-cutting and must update specs before code:

| Area | Spec |
|---|---|
| Shared product terms, contracts, DB schema | `specs/A-shared-definitions.md` |
| Workspace root, Home target, checkouts, migration, structured/freestyle modes | `specs/B.1-repositories-workspaces.md` |
| Navigator tree, Agents nav config, workspace automation/history UI, local notifications | `specs/B.2-ade-cockpit.md`, `specs/B.8-ui-performance-quality.md` |
| Agent sessions, tabs vs durable history, runtime session id, role/action sessions | `specs/B.3-agent-sessions-terminal.md` |
| PR gates, stacked PRs, conflict tracking, restacking, review artifacts | `specs/B.4-git-pr-ci-diff.md` |
| Providers, ticket status updates, runtime model/launch option discovery | `specs/B.6-providers-hooks-config.md` |
| MCP tools, manager state machine, plan registration/versioning, activity/events | `specs/B.7-operations-activity-mcp.md` |
| Build/architecture constraints and migration safety | `specs/C-technical-stack.md` |

Existing spec text in `B.2`, `B.3`, `B.6`, and `B.7` already reflects the superseded custom-agent/single-workspace launcher plan. The first implementation step must replace that with the new model so later agents do not implement the wrong contract.

## Implementation Approach

### Product Model

Use these canonical terms:

- **Workspace:** a feature/task container. It has a root directory, lifecycle, optional external parent issue binding, optional manager instance, plan history, and Home target.
- **Workspace Home:** the unremovable execution target rooted at the workspace root. PM, architect, and manager run here.
- **Worktree checkout:** one repo worktree under the workspace root. It has repo id, path, branch, base branch, optional child issue binding, intended PR metadata, stack relationship, gate state, and inferred purpose.
- **Agent session:** a durable runtime conversation record. A tab is only the currently open tmux-backed view of a session.
- **Role template:** one of the five built-in roles with system prompt and launch settings.
- **Action template:** a role-owned built-in triggered action with prompt and launch settings.
- **Manager instance:** the workspace supervisor state machine, one per structured workspace, optional for freestyle workspaces.
- **Workspace plan version:** a registered reviewed plan artifact with autoincrement version, status, hash, review artifacts, decisions, and one active approved version.
- **Implementation gate:** per-checkout delivery state derived from PR/CI/conflict/review/plan facts and current active sessions.

### Storage Shape

The implementation should remodel `workspaces` as the top-level root entity and move repo/branch/PR fields to a child checkout table. Because this install is local-first and effectively single-user, an automatic once-on-start migration is acceptable, but it must be idempotent and protect dirty worktrees.

Expected core DB additions/changes:

- Add explicit `workspaces.root_path` and `workspaces.mode` first. Do not silently change all call sites to reinterpret `workspaces.path`; existing code may still assume it is a checkout path. New code must use typed accessors (`workspaceRootPath`, `checkoutPath`, `executionTargetCwd`) while callers are migrated.
- `workspaces.path` remains a legacy/current-primary-checkout path during the compatibility phase. It can be deprecated or rebuilt only after every repo/branch/PR/terminal caller has moved to `workspace_checkouts.path` or `workspaces.root_path`.
- New `workspace_checkouts` table:
  - `id`
  - `workspace_id`
  - `repo_id`
  - `name`
  - `path`
  - `branch`
  - `base_branch`
  - `issue_provider`, `issue_key`, `issue_url`
  - `intended_pr_provider`, `intended_pr_number`, `intended_pr_url`, `pr_head_sha`, `pr_base_ref`
  - `stack_parent_checkout_id`
  - `inferred_purpose` nullable (`prototype`/`implementation` only when claimed by workflow)
  - `gate_status`
  - timestamps and archive fields
- New `agent_templates` storage under user config or daemon data for five predefined role/action templates. This may be file-backed like the current branch if boot-safe, but must not expose custom-agent CRUD.
- `agent_sessions` extended with target scope and role/action metadata:
  - `target_type` (`workspace_home` or `worktree_checkout`)
  - `checkout_id` nullable
  - `role`
  - `action_id` nullable
  - `managed` boolean
  - `parent_session_id` nullable
  - `plan_version_id` nullable
  - `runtime_session_id` retained
  - `closed_at` or equivalent tab lifecycle metadata
- New plan/version tables:
  - `workspace_plan_versions`
  - `workspace_plan_reviews`
  - `workspace_plan_decisions`
- New checkout artifact tables:
  - `checkout_review_artifacts` for `review-pr`
  - optional generic `checkout_artifacts` if useful for prototype PRs, CI fix notes, conflict fix notes
- New manager tables:
  - `workspace_managers`
  - `manager_events` or activity-backed event records for heartbeat/action history
  - `plan_deviation_reports`
- Idempotency/lease fields or tables:
  - one manager row per workspace (`UNIQUE(workspace_id)`)
  - one active manager action per scope/action key
  - one checkout per active plan delivery-unit key
  - one review artifact/gate attempt per checkout + PR head SHA + plan version + action attempt
- Optional notification settings/state for local browser notifications and sound preferences.

Do not add local work item rows as a planning source of truth. For structured work, child tickets are read live from the issue provider and Citadel stores only local execution bindings.

### Filesystem Layout

New structured workspace layout:

```text
~/Workspace/citadel-workspaces/feature-billing-retry/
  .citadel/workspace.json
  .agents/plans/
  api/
  web/
  worker/
```

Existing single-repo workspaces migrate to:

```text
<workspace-root>/
  .citadel/workspace.json
  <checkout-name>/
```

Migration must use `git worktree move` on the same filesystem. If same-device worktree move is unavailable, skip automatic migration and surface manual action. No full backup copy is required.

For existing workspaces, the safe move shape is:

1. `oldCheckoutPath = current workspaces.path`.
2. `finalRootPath = oldCheckoutPath` so existing operator-visible workspace path remains the workspace root.
3. `tempCheckoutPath = sibling path "<oldCheckoutPath>.citadel-migrating-<workspaceId>"`.
4. `finalCheckoutPath = path.join(finalRootPath, checkoutName)`.
5. Use `git worktree move oldCheckoutPath tempCheckoutPath`.
6. Create `finalRootPath`.
7. Use `git worktree move tempCheckoutPath finalCheckoutPath`.
8. Update DB only after all verification passes.

Do not use raw `mv` for Git worktrees in the automatic path. If `git worktree move` is unavailable or fails, skip automatic migration and surface a manual action. If a partially moved state is detected, use the migration manifest and `git worktree list --porcelain` / `git worktree repair` only as an explicit recovery path before DB mutation.

### Agent Templates And Actions

The Agents nav edits five predefined roles:

- `pm`
- `architect`
- `implementation`
- `prototype`
- `manager`

Each role has:

- system prompt
- launch settings (`runtimeId`, `model`, `effort`, `fastMode`, `contextMode`)
- required role identity and required built-in actions
- reset-to-Citadel-defaults

Action templates belong under roles. Initial action set:

- `implementation.review_pr`
- `implementation.fix_ci`
- `implementation.fix_conflicts`
- `implementation.poke_idle_without_pr`
- `implementation.restack_checkout`
- `architect.replan_from_deviation`
- `manager.heartbeat_digest`
- `manager.notify_ready_for_human_review`
- `manager.update_ticket_status`
- prototype actions can start minimal and be expanded when prototype/autogrill is specified in detail

Action execution mode supports `new_session` or `existing_session`. Existing-session actions target the last active matching session for role/scope; if none exists, create a new session by default. `review_pr` always launches a new session.

### Runtime Launch Settings

Runtime config and adapters must support:

- model discovery
- default model discovery
- model launch argument mapping (`modelArg` or adapter-specific mapping)
- effort/reasoning argument mapping when supported
- fast mode argument mapping when supported
- max-context/context mode argument mapping when supported
- static fallback capabilities/model defaults when live probing is unavailable

Role/action templates store semantic launch settings. At launch:

1. Resolve runtime.
2. Fetch/validate current runtime capabilities and model list using live adapter data when available, otherwise static config fallback.
3. If selected model is unavailable, fall back to runtime default.
4. Drop unsupported effort/fast/context options.
5. Record warnings and capability freshness timestamps on the session/action event.
6. Build runtime-specific argv through a central launch-profile resolver before `createAgentSession`.

### MCP Direction

Prefer explicit target ids for UI/daemon calls and `cwd` for agent-facing calls. Every `cwd` input must realpath and resolve to a Citadel-registered workspace root or checkout. Unknown paths return an error. Resolution is most-specific-first: exact checkout or descendant of checkout wins over workspace root; Home matches only the workspace root itself or a non-checkout descendant under the root.

New or redesigned MCP tools should include:

- `launch_pm_agent`
- `launch_architect_agent`
- `launch_implementation_agent`
- `launch_prototype_agent`
- `start_workspace_manager`
- `pause_workspace_manager`
- `resume_workspace_manager`
- `register_workspace_plan`
- `get_workspace_plan`
- `report_plan_deviation`
- `mark_checkout_ready_for_review`
- `get_citadel_context`
- `get_checkout_ticket`
- `get_checkout_pr`
- `get_checkout_gate_status`
- `list_workspace_checkouts`
- `create_workspace_checkout`
- `update_ticket_status`

Do not ship `list_custom_agents` or `launch_custom_agent` in v1.

### Manager State Machine

Manager uses durable workspace/checkouts/plan/session state, not transcript parsing, as source of truth. It wakes on events and on a configurable tick.

Core managed states/facts:

- workspace lifecycle phase
- current active plan version
- discovery readiness
- plan approval mode
- active implementation/prototype/review/fix sessions
- checkout PR identity/head SHA/checks/conflicts
- review artifact status for current head SHA
- plan deviation reports
- stack dependency state
- local notification state

Manager can launch agents and call MCP tools directly. Safety and idempotency live inside the tools.

Every manager-triggered side effect must:

- check global and workspace pause state before executing
- be covered by an explicit tool/action allowlist for that manager action
- use idempotency keys so retrying the same event does not duplicate work
- write an activity/audit event with the triggering fact and resulting operation/session/artifact
- require human confirmation for destructive archive/remove/delete operations even when called by manager

### Plans And Handoff

Architect plan format starts from `/do-tech-plan` and must add these required sections:

```markdown
## Delivery Units
[Each unit: child ticket, repo, checkout/branch strategy, intended PR, role/model hints if needed]

## Dependencies / Timeline
[Edges: parallel, stacked_on_pr, wait_for_merge_or_release, manual. Include default start condition.]

## Manager Handoff
[What manager should create, launch, gate, notify, and watch.]

## Plan Version Notes
[Human-readable summary of what changed from prior plan version when applicable.]
```

Plan registration creates the next autoincrement workspace version. Plan statuses:

- `draft`
- `under_review`
- `changes_requested`
- `approved`
- `superseded`

Only one approved plan is active. Implementation sessions record the plan version they launched with.

### PR And Review Gates

Per implementation checkout, ready for human review requires:

1. PR exists.
2. Checks are green.
3. No conflicts/mergeability blockers.
4. `review-pr` artifact exists for the current PR head SHA and active plan version.
5. No unresolved plan deviation affecting this checkout.
6. No newer active plan version that has not been acknowledged by the implementation session.
7. The `review-pr` artifact completed successfully and has no blocking findings, or every blocking finding is explicitly resolved by a later review artifact or waived by a recorded human decision. Manager/implementation agents cannot self-waive blocking findings.

Any head SHA change invalidates the review gate. Conflict fixes, CI fixes, restacks, or manual commits all trigger review invalidation.

### Stacked PRs

The architecture plan must tell manager which delivery units are parallel, stacked, or true wait-for-merge/release dependencies.

Default stacked behavior:

1. Upstream checkout reaches ready-for-human-review.
2. Manager creates downstream checkout from upstream branch/head.
3. If base/main changes, update bottom PR first, then each downstream checkout from its parent.
4. If upstream changes, mark downstream `needs_restack`.
5. Manager runs restack in order and re-runs PR gates for every changed checkout.

### External Issue Provider

Structured workspaces bind to one ticket provider. Jira is expected first, but contracts should stay provider-neutral.

Provider binding is not required for early structured discovery. A PM bootstrap can create a structured workspace from an idea without a parent issue. Before structured implementation starts, Citadel must have a parent issue binding and each implementation checkout must bind to one child ticket. If the user wants to code without tickets, they should use a freestyle workspace/session instead of structured implementation.

Citadel reads planning fields live from provider:

- parent title/description/AC/status
- child task list/title/description/AC/status

Citadel stores:

- parent issue binding on workspace
- child issue binding on checkout
- prompt snapshots used at agent launch
- execution status/events/artifacts

Ticket status transitions are best-effort manager-triggered provider actions. For v1, the manager/tool may inspect provider transitions live and move the issue toward an internal state (`todo`, `in_progress`, `in_qa`, `in_review`, `done`). Record only lightweight result facts: issue key/url, requested internal state, resulting external status, success/failure, timestamp, actor/session.

Provider facts used for gates must carry freshness:

- PR/CI/conflict facts include fetched-at timestamps and provider cooldown/rate-limit state.
- Unknown or stale PR/CI/conflict state does not satisfy readiness.
- Manager may continue running implementation agents while provider data is stale, but cannot mark a checkout ready for human review until required provider facts are fresh enough.

### Local Notifications

V1 notifications are local only:

- in-app activity/alert
- optional browser/PWA desktop notification after permission
- optional sound

Default notification trigger: each PR becomes ready for human review. External Slack/Teams/email providers are deferred.

## Alternatives Considered

1. **Continue current branch and ship custom agents first.** Rejected. The branch solves a narrower prompt-template problem and would confuse future implementation by cementing custom agents, old launcher semantics, and local-only handoff.
2. **Keep current single-repo workspace and add multi-repo later.** Rejected. Manager launch rules, Home-scoped PM/architect sessions, zero-checkout discovery, and multi-checkout monorepo work all depend on workspace root/checkouts.
3. **Model local work items in Citadel.** Rejected. Issue providers own planning content. Citadel stores execution bindings and artifacts only.
4. **Make manager a normal launchable role only.** Rejected. Manager needs durable supervisor state, heartbeat, pause controls, gate tracking, and action history.
5. **Use arbitrary user-defined triggers in v1.** Rejected. Built-in triggers/actions are enough, and unrestricted automation would be hard to make safe before the state machine is proven.
6. **Wait for PR merge before starting dependent work.** Rejected as default. Same-repo dependent work should use stacked PRs and start after upstream green/reviewed; true wait-for-merge/release remains an explicit dependency edge type.
7. **Static Jira status mappings through hooks.** Rejected for v1. Agent/provider actions can inspect transitions live and record the result; static mappings can be added later if repeated workflows justify them.
8. **Prompt-template interpolation for all context.** Rejected. Agents run in scoped cwd and use MCP tools for live context. Prompts can stay mostly static.

## Implementation Steps

### 0. Branch Hygiene And Current Worktree

- Start implementation from clean `main` on `fb-agents-orchestration-v2`.
- Treat current branch changes as superseded. Cherry-pick only after comparing against this plan.
- Remove or replace obsolete spec text about custom agents, `list_custom_agents`, `launch_custom_agent`, and old `register_plan`.

### 1. Specs First

- Update `specs/A-shared-definitions.md` with Workspace, Workspace Home, Worktree checkout, Role template, Action template, Manager instance, Workspace plan version, Review artifact, and Implementation gate.
- Update `specs/B.1-repositories-workspaces.md` for root-directory workspaces, Home, checkouts, zero-checkout structured workspaces, multi-checkout same repo, one checkout/branch/PR, and automatic migration.
- Update `specs/B.2-ade-cockpit.md` for workspace tree navigation, Home/checkouts/tabs, Agents config nav, specialized-vs-freestyle launch UI, agent history, manager state panels, and local notifications.
- Update `specs/B.3-agent-sessions-terminal.md` for target-scoped sessions, durable session history vs live tabs, runtime session resume, role/action metadata, and close-tab semantics.
- Update `specs/B.4-git-pr-ci-diff.md` for implementation gates, `review-pr` artifacts, head-SHA invalidation, conflict tracking until merge, stacked PR edge types, and automatic restacking.
- Update `specs/B.6-providers-hooks-config.md` for provider-neutral ticket bindings, live ticket reads, best-effort ticket transitions, runtime model/effort/fast/context discovery and launch mapping.
- Update `specs/B.7-operations-activity-mcp.md` for redesigned role launchers, manager tools, context-by-cwd tools, plan version registration, deviation reports, completion signals, and removal of custom-agent MCP tools from v1.
- Update `specs/B.8-ui-performance-quality.md` if new navigator/agent-history UI introduces performance expectations.

### 2. Contracts

- Replace the current `AgentDefinition` shape with `RoleTemplate`, `ActionTemplate`, and `LaunchSettings` schemas.
- Add semantic launch settings:
  - `runtimeId`
  - `model`
  - `effort`
  - `fastMode`
  - `contextMode`
- Add runtime capability/model schemas covering model list, default model, supported effort values, fast mode, and context modes.
- Add workspace root/checkouts contracts:
  - `WorkspaceMode`
  - `WorkspaceLifecyclePhase`
  - `WorkspaceHomeTarget`
  - `WorktreeCheckout`
  - `ExecutionTarget`
  - `IssueBinding`
  - `PullRequestBinding`
  - `CheckoutGateStatus`
- Add plan/version contracts:
  - `WorkspacePlanVersion`
  - `WorkspacePlanReview`
  - `WorkspacePlanDecision`
  - `RegisterWorkspacePlanInput`
  - `PlanDeviationReport`
- Add manager contracts:
  - `WorkspaceManager`
  - `ManagerPauseState`
  - `ManagerEvent`
  - `ManagerHeartbeatConfig`
- Extend agent-session contract with target scope, role/action metadata, managed flag, plan version, parent session, closed/restorable lifecycle.
- Add MCP input schemas for redesigned launchers and context tools. Remove v1 custom-agent tool schemas.

### 3. Database And Migration

Migration strategy:

| Operation | Classification | Notes |
|---|---|---|
| Add `workspaces.root_path`, `workspaces.mode`, and structured workspace fields while keeping `workspaces.path` as legacy primary-checkout path | Additive | Transitional invariant: `root_path` is workspace root, `path` remains legacy checkout path until every caller uses typed accessors. |
| Create `workspace_checkouts` | Additive | Child table for repo worktrees. |
| Backfill one checkout for each existing worktree workspace | Data backfill | Preserve repo/branch/path/PR/issue fields. |
| Move existing worktree directories under new workspace roots | Filesystem migration | Automatic once, same-device only, dirty-safe verification required. |
| Extend `agent_sessions` with target/role/action/history fields | Additive | Nullable/defaulted for existing rows. |
| Create role/action template storage if DB-backed | Additive | File-backed user config is also acceptable if boot-safe. |
| Create `workspace_managers` and manager event/deviation tables | Additive | One manager per structured workspace. |
| Create workspace plan version/review/decision tables | Additive | Autoincrement version per workspace. |
| Create review artifact table | Additive | Tracks `review-pr` by checkout, PR head SHA, plan version. |
| Create local notification state table if needed | Additive | Optional if browser permission state remains client-local. |

`schema_migrations` target: if starting from clean `main` whose max is v12, use v13 named `workspace-home-checkouts-manager`. If implementation keeps any current-branch obsolete v13 plan-registration row, replace it with this migration or renumber to the next contiguous version. Do not ship both the obsolete local plan-registration migration and this model.

Preserve `PRAGMA foreign_keys = ON`.

Operator data implications:

- Existing local workspaces are migrated on daemon startup.
- Dirty worktrees are moved only if pre/post `git status --porcelain` matches and `.git` worktree metadata remains valid.
- Root/imported repo workspaces are not moved as checkouts unless explicitly Citadel-managed worktree records.
- Failed/skipped migrations leave the old workspace untouched and surface a blocking admin/readiness item.

### 4. Workspace Filesystem And Operations

- Add operations for creating structured workspace shells with zero checkouts.
- Add operations for adding/removing/archiving worktree checkouts under a workspace root.
- Add same-repo multi-checkout support with unique checkout names and branches.
- Add checkout creation from:
  - scratch branch off repo default branch
  - existing branch
  - PR
  - upstream checkout branch for stacked PRs
- Add automatic migration runner with manifest and idempotent resume behavior.
- Update cleanup/archive/remove logic to operate at workspace root and checkout levels without deleting dirty work unexpectedly.

### 5. Runtime Launch Profiles

- Add `LaunchProfile` resolver in `packages/runtimes` or `packages/operations` that maps semantic launch settings to runtime argv.
- Extend runtime config schema with configurable mappings for model, effort, fast mode, and context mode where runtime supports them.
- Add per-runtime adapters for model/default/capability discovery for `claude-code`, `codex`, `cursor-agent`, and `pi`.
- Update `createAgentSession` so callers pass launch settings/model options and the resolver builds argv before spawn/resume.
- Persist launch warnings on the session/activity when model/options fall back.
- Keep prompt submission separate from model selection. Model selection must affect actual runtime invocation.

### 6. Agent Templates And Agents Nav

- Build predefined role/action template storage with seeds for the five roles.
- Remove/defer custom agent create/delete/list surfaces from this plan.
- Add `/api/agent-templates` endpoints for list/update/reset role and action templates.
- Add model/effort/fast/context selectors driven by runtime capabilities.
- Build `/agents` route in the cockpit:
  - role list
  - role prompt editor
  - role launch settings editor
  - role-owned action list/editor
  - reset controls
  - validation warnings
- Keep live workspace manager state out of the global Agents nav.

### 7. Execution Targets, Tabs, And History UI

- Add API/state shape for workspace tree: workspace, Home target, checkouts, sessions grouped by target.
- Update navigator to render workspace > Home/checkouts.
- Update Stage tab strip to operate on selected execution target.
- Update launch menu:
  - Home: PM, Architect if discovery ready, Manager/manual, freestyle runtimes, Terminal.
  - Checkout: Implementation if plan ready plus parent/child ticket bindings exist in structured mode, Prototype, freestyle runtimes, Terminal.
  - Hide invalid specialized roles.
- Add specialized role/action visual marker distinct from freestyle runtime sessions.
- Add workspace-level agent history panel showing closed/restorable sessions across Home/checkouts.
- Implement close-tab behavior: kill tmux, mark tab closed, retain runtime session id/history for restore.

### 8. Structured Workspace Lifecycle

- Add workspace mode/lifecycle state.
- Add PM bootstrap flow:
  - input idea/prompt
  - optional parent issue key/url
  - optional workspace name/provider/project
  - create structured workspace shell
  - create manager instance
  - launch PM on Home
- Add discovery artifact/readiness state. Human marks discovery ready.
- Add PM-to-architect handoff action with `planApprovalMode`.
- Enforce architect launch preconditions.
- Enforce implementation launch preconditions in structured mode: active approved plan, parent issue binding, and exactly one child ticket binding for the checkout/delivery unit.
- Enforce automation pause only on manager/agent-triggered automated actions. Human UI/manual specialized launches remain allowed while paused, but should show a paused-automation warning and should not trigger manager follow-up until unpaused.

### 9. Workspace Plans And Review

- Implement `register_workspace_plan` MCP/API:
  - accepts `workspaceId` or validated `cwd`
  - accepts local path and later provider attachment/link
  - validates local paths inside workspace root
  - computes hash
  - allocates next workspace plan version
  - records status/review/decision
- Add plan version UI/history on workspace Home.
- Update architect default prompt to require `/do-tech-plan` structure plus Delivery Units, Dependencies / Timeline, Manager Handoff, and Plan Version Notes.
- Model `review-tech-plan` as a first-class action runner, not just a prompt instruction. It must register review artifacts, status, failures, and the final approved/overridden decision before a plan version can become active.
- Manager reacts only to final approved/auto-approved active plan.
- Active-plan automation that creates implementation checkouts must validate parent issue binding and one child ticket per delivery unit before launching implementation. Missing/ambiguous ticket bindings pause only the affected delivery unit when possible.

### 10. Manager Instance And Heartbeat

- Create manager instance at structured workspace creation.
- Add global and per-workspace automation pause controls.
- Store enough actor/source metadata on launch requests to distinguish human manual launches from manager/agent-triggered automated actions.
- Implement event bus hooks for:
  - plan registered/approved
  - agent status changes
  - plan deviation report
  - checkout completion signal
  - PR opened/head changed/checks changed/conflicts changed
  - base branch moved
  - review artifact registered
  - ticket transition result
- Add configurable periodic tick.
- Implement manager decision loop as deterministic state machine that calls role/action launch helpers and MCP tools.
- Add manager Home session launch/resume for audit/context where useful.

### 11. MCP Tools

- Redesign role launchers around target rules:
  - `launch_pm_agent` can bootstrap workspace or target Home.
  - `launch_architect_agent` targets Home and requires discovery ready + `planApprovalMode`.
  - `launch_implementation_agent` targets checkout and requires active plan + parent issue + exactly one child ticket binding in structured mode.
  - `launch_prototype_agent` targets checkout and can run before plan ready.
- MCP/daemon launchers that can be called by agents must enforce pause for automated actors. Human UI launch routes must either pass an explicit human/manual actor or use a separate code path so pause semantics cannot be bypassed accidentally by agents.
- Add manager lifecycle tools.
- Add context resolution tools that accept `cwd` and validate against registered paths.
- Add plan/deviation/completion/gate tools.
- Remove v1 custom-agent tools.
- Ensure all side-effectful MCP tools emit operations/activity and are idempotent where manager may retry.

### 12. Implementation Gates, PRs, And Review Artifacts

- Track intended PR binding per checkout.
- Detect PR existence/head SHA/checks/conflicts per checkout.
- Add `mark_checkout_ready_for_review` tool for implementation agents.
- Manager verifies `reviewPrerequisites` before launching `implementation.review_pr`: PR exists, checks are green, conflicts are absent, provider facts are fresh, active plan version is current, and no blocking deviation affects the checkout. Full `readyForHumanReview` is evaluated only after the review artifact is registered.
- Model `review-pr` as a first-class action runner under the implementation role, not just a prompt instruction.
- Implement `review-pr` action launch in separate session with required artifact registration, parseable result status, failure status, retry behavior, and artifact path/link.
- Store review artifacts with checkout id, PR id/url, head SHA, plan version, result, findings status, blocking findings, human waiver decisions, artifact path/link, timestamps.
- Invalidate review gate on head SHA change, conflict fix, CI fix, restack, or plan version mismatch.

### 13. Stacked PRs And Restacking

- Parse plan dependency edge types.
- Add checkout stack relationships.
- Implement stacked checkout creation from upstream branch/head.
- Implement base branch change detection as stack invalidation trigger.
- Implement manager-owned restack orchestration:
  - update bottom checkout from base
  - update each child from parent
  - launch fix-conflicts/restack sessions when needed
  - re-run CI/review gates after head changes
- Add restack edge-case coverage for force-push, upstream branch deletion, manual rebase, partial stack failure, and provider stale/unknown state.

### 14. Issue Provider Integration

- Add provider-neutral issue binding contracts for parent and child tickets.
- Implement live child-ticket reads for Jira first through existing shell-backed provider approach.
- Add best-effort `update_ticket_status` action/tool:
  - manager requests internal target state
  - provider action inspects transitions live
  - records resulting external status
  - failures become warnings/activity, not delivery blockers
- Ensure Citadel stores prompt snapshots for agent launches that include external issue content.

### 15. Local Notifications

- Add in-app activity/readiness notification when a PR becomes ready for human review.
- Add optional browser notification permission flow.
- Add optional sound setting and playback for ready/human-input-needed events.
- Keep external notification providers out of v1.

### 16. Current Branch Cleanup

- Delete or rewrite code from the current branch that conflicts with this plan:
  - custom agent CRUD
  - `list_custom_agents`
  - `launch_custom_agent`
  - old `register_plan`
  - old `launch_handoff_agent`
  - old single-repo launcher assumptions
- Salvage only:
  - boot-safe predefined-template storage if adapted to five roles/actions
  - model discovery code if extended to launch profiles
  - plan-registration tests only if rewritten around workspace plan versions

### 17. Feature Exposure Controls

- Keep incomplete structured workspace/manager surfaces behind a feature flag or hidden/admin-only route until a coherent user-facing path is available.
- Do not expose a migration prompt, structured workspace creation, or manager automation UI before the corresponding backend invariants and rollback/readiness states are implemented.
- Each suggested PR slice may merge internal contracts/services first, but user-visible affordances should appear only when they can complete the flow they advertise.

## Migration Strategy

### Schema Operations

The implementation must include an explicit DB migration test for every operation below.

1. Add `workspaces.root_path`, `workspaces.mode`, external parent issue binding, lifecycle phase, and manager linkage. Keep `workspaces.path` compatibility until callers are migrated.
2. Create `workspace_checkouts` with FK to `workspaces` and `repos`.
3. Backfill one checkout for every existing worktree workspace.
4. Extend `agent_sessions` with target/role/action/history fields.
5. Create workspace manager tables.
6. Create workspace plan version/review/decision tables.
7. Create plan deviation table.
8. Create review artifact table.
9. Create any notification preference/state table if server-side state is needed.
10. Insert `schema_migrations` row for the next contiguous version.

### Filesystem Migration

Automatic workspace layout migration must:

- write a manifest before starting each workspace migration
- run before boot restore/session respawn for the affected workspace
- skip any workspace that still has a live Citadel tmux session or active operation
- verify original path exists and is a git worktree
- capture `git status --porcelain`
- capture `git rev-parse --show-toplevel`, `git rev-parse --git-common-dir`, current branch, HEAD, and `git worktree list --porcelain`
- move with `git worktree move` to a sibling temp path, create the root path, then `git worktree move` into the root as a checkout
- verify `.git` file/gitdir remains valid and `git rev-parse --show-toplevel` returns the final checkout path
- verify branch, HEAD, common dir, and worktree list remain coherent
- verify `git status --porcelain` after move matches before move
- update DB only after filesystem verification succeeds
- be idempotent if daemon crashes mid-migration
- skip cross-device moves, missing paths, target collisions, broken git state, or root/imported repositories
- inventory existing Citadel-owned artifacts under the old checkout path. Workspace-level artifacts such as `.agents/plans` move/reindex to Home; repo-local files remain inside the checkout; external runtime transcripts stay in their runtime-owned locations and are relinked through session history.

No full backup copy is required.

### Version

Target `schema_migrations` version is v13 if starting from clean `main` with current max v12. If the implementation branch already contains an obsolete v13 row from the superseded plan, replace it or renumber to the next contiguous version before review.

### Foreign Keys

`PRAGMA foreign_keys = ON` remains required. New child tables use FK constraints with clear cascade behavior:

- checkouts cascade/archive with workspace according to product cleanup rules
- plan versions cascade with workspace
- review artifacts cascade with checkout
- sessions keep enough history; do not cascade-delete useful audit rows unless workspace is fully removed with explicit cleanup

## Hard Gate Commitments

### Architecture Boundaries

- `packages/contracts` owns shared schemas and types only.
- `packages/db` owns SQLite schema/store methods only; it does not import daemon/web/runtime internals.
- `packages/operations` owns filesystem/worktree operations and manager reducers that are independent of Express.
- `apps/daemon` owns HTTP/MCP wiring and provider-backed orchestration.
- `apps/web` consumes daemon APIs through shared contracts only; it must not import daemon internals.
- `packages/core` remains pure. Do not add filesystem, process, React, DB, provider, terminal, runtime, daemon, or MCP imports there.
- New cross-package imports must be checked against `scripts/checks/architecture-boundaries.ts`, and the script must be extended if the new architecture introduces a boundary not currently covered.

### File Size

No new non-generated source file may exceed the 800-line limit. Implementation should split large areas up front:

- daemon route modules separate from `app.ts`
- manager reducer/state-machine modules separate from route/MCP wiring
- checkout store/helpers separate from the main DB store file where practical
- web workspace tree, agent history, and Agents config editors as separate focused components

If an existing file is near the limit, the implementation step must extract a sibling module instead of appending.

### Provider Degradation

Provider-backed features must degrade clearly:

- If ticket provider health is unavailable, structured workspace still shows existing local bindings/history, but live child-ticket reads and ticket status updates show a provider-unavailable state.
- If PR/CI provider health is unavailable or rate-limited, manager does not mark gates complete from stale data. It waits, records a warning/activity item, and notifies locally when human attention is needed.
- Ticket status transitions are best-effort and never block code delivery.
- Provider-derived prompt snapshots must record when provider data was unavailable/stale so downstream sessions know what context they actually received.

### Workspace Cleanup And Migration Safety

- Workspace migration must not delete dirty worktrees.
- Dirty worktrees may be moved only when pre/post `git status --porcelain` matches.
- Root/imported repository workspaces are not moved automatically.
- Same-device rename is the automatic path. Cross-device copy/delete is not automatic.
- Failed/skipped migrations leave the original workspace untouched and produce a visible readiness/admin item.
- Remove/archive cleanup paths must retain the existing dirty-worktree protections and log any explicit force policy if one is later added.

### Terminal Completeness

This plan should not require changing the terminal renderer or low-level PTY input path. It does change agent-session metadata, close-tab semantics, restore/history behavior, and runtime launch argv construction. If implementation touches `packages/terminal`, ttyd proxying, xterm input, resize, paste, or terminal attach/reconnect behavior, terminal completeness applies and tests must cover raw input, control/meta sequences, paste, resize, long output, alternate screen where supported, reconnect, and cross-session isolation. If implementation only changes metadata while leaving terminal transport untouched, add targeted regression tests for close-tab/restore/session-history behavior.

### Lockfile And Dependencies

No new runtime dependency is expected for v1. If implementation adds, removes, or upgrades dependencies:

- use pnpm only
- do not introduce `package-lock.json` or `yarn.lock`
- justify each dependency in the PR
- inspect package lifecycle scripts (`preinstall`, `install`, `postinstall`) before accepting the dependency

## QA/Test Strategy

### Layer Evaluation

| Layer | Verdict | Details |
|---|---|---|
| Unit (Vitest) | Required | Contracts, DB migrations, filesystem migration planner, runtime launch-profile resolver, template storage, MCP context resolution, manager state machine, gate reducers, stack planner, provider status action results, and React components/hooks need unit coverage. |
| E2E (Playwright) | Required | New workspace tree, PM bootstrap, Agents config, specialized launch rules, checkout launch, manager pause, local notification readiness, and restore/history flows need browser coverage because they are core user journeys. |

### New Tests To Add

- `packages/contracts/src/index.test.ts`: role/action templates, launch settings, execution targets, checkouts, plan versions, manager state, review artifacts, MCP inputs.
- `packages/db/src/migration.test.ts`: v13 schema rows, workspace rebuild/backfill, FK behavior, existing-data migration.
- `packages/db/src/workspace-checkouts.test.ts`: checkout CRUD, multiple checkouts per repo/workspace, stack relationships.
- `packages/operations/src/workspace-layout-migration.test.ts`: dirty worktree migration preserves status, same-device move, skip cases, idempotent crash recovery.
- `packages/operations/src/workspace-layout-migration.test.ts`: `git worktree move` sequence, temp path crash recovery, branch/HEAD/common-dir preservation, active-session skip, artifact relocation/reindexing.
- `packages/operations/src/create-workspace.test.ts` or equivalent: zero-checkout structured workspace shell creation with Home-only specialized roles.
- `packages/operations/src/create-worktree-checkout.test.ts`: checkout creation from default branch, existing branch, PR, and upstream checkout for stacked work.
- `packages/runtimes/src/launch-profile.test.ts`: model/effort/fast/context argv mapping and fallback warnings.
- `apps/daemon/src/agent-templates-routes.test.ts`: list/update/reset five predefined roles/actions and no custom CRUD.
- `apps/daemon/src/mcp-context-tools.test.ts`: cwd realpath validation and unknown path errors.
- `apps/daemon/src/role-launchers.test.ts`: target rule enforcement, PM bootstrap, architect preconditions, implementation plan gate, prototype pre-plan launch.
- `apps/daemon/src/workspace-plan-routes.test.ts`: register plan, autoincrement versions, active plan rules, review/decision history.
- `apps/daemon/src/manager-state-machine.test.ts`: plan-ready auto/manual behavior, pause behavior, completion signal, review launch, plan deviation, replan, notification triggers.
- `apps/daemon/src/manager-idempotency.test.ts`: duplicate heartbeat/event delivery does not duplicate sessions, checkouts, reviews, restacks, or ticket transitions.
- `apps/daemon/src/pr-gates.test.ts`: PR exists/checks/conflicts/review artifact/head SHA invalidation.
- `apps/daemon/src/stack-orchestration.test.ts`: stacked start condition, base update cascade, restack ordering, force-push, upstream deletion, manual rebase, and partial stack failure.
- `apps/web/src/agents-template-editor.test.tsx`: role/action editor, reset, runtime/model option validation.
- `apps/web/src/workspace-tree.test.tsx`: Home/checkouts tree, specialized/freestyle markers, valid launch options.
- `apps/web/src/agent-history.test.tsx`: closed/restorable sessions and runtime session id display.
- `e2e/structured-workspace.spec.ts`: PM bootstrap creates workspace shell/Home and launches PM.
- `e2e/agents-config.spec.ts`: edit/reset role/action launch settings.
- `e2e/workspace-checkouts.spec.ts`: add checkout, launch implementation only after plan ready, show specialized icon.
- `e2e/manager-readiness.spec.ts`: manager marks PR ready locally and surfaces notification/activity.

### Existing Tests To Update

- Workspace creation tests in `packages/operations/src/index.test.ts` and daemon route tests to understand workspace root + checkout creation.
- Existing `agent-session` tests to include target scope, role/action metadata, closed tab history, runtime session resume.
- Existing PR/conflict tests to move PR state from workspace-level assumptions to checkout-level bindings.
- Existing navigator/stage tests to group sessions by Home/checkouts.
- Existing MCP tests to remove custom-agent expectations and assert new role/manager/context tools.
- Existing specs/tests from the current branch that mention `plan_registrations` must be rewritten or removed.

### Assertions To Add/Change/Tighten

- A structured workspace can exist without `repoId`/checkout.
- A workspace can have two checkouts for the same repo.
- A checkout cannot satisfy implementation readiness without exactly one intended PR.
- In structured mode, implementation role launch fails before active plan exists.
- In structured mode, implementation role launch also fails without parent issue binding or exactly one child ticket binding.
- Prototype role launch does not require active plan but does require a checkout target.
- Architect launch fails until discovery is marked ready and `planApprovalMode` is provided.
- Closing a tab removes tmux but preserves session history and runtime session id.
- `cwd` context tools reject paths outside registered workspace roots/checkouts, including symlink escapes.
- Path containment uses `path.relative`/resolved-root equality semantics, not raw string prefix checks.
- Context resolution is most-specific-first: checkout exact/descendant beats workspace Home root; Home matches root or non-checkout descendants only.
- Deprecated model fallback records a warning and uses runtime default.
- Review artifact for old PR head SHA does not satisfy readiness.
- Review artifact with blocking unresolved findings does not satisfy readiness.
- Any head SHA change invalidates review gate.
- Conflict appearance after readiness revokes readiness.
- Stack restack order is parent before child.
- Pause blocks manager/agent-triggered automated actions but does not block human manual launches or local notification events.
- Agent-callable launcher paths cannot bypass pause by spoofing human/manual source metadata.

### Failure Modes / Edge Cases / Regression Risks

- Filesystem migration loses dirty/untracked files or updates DB before move verification.
- Existing root repo workspaces are accidentally moved or deleted.
- UI still assumes workspace has a single repo/branch and hides checkouts.
- Agent sessions launch in the wrong cwd.
- Manager duplicates agents because it ignores active session state.
- Manager never pokes because it waits only on events and misses a transition.
- Custom-agent endpoints leak into v1 and confuse MCP clients.
- Runtime model fallback silently changes behavior without recording a warning.
- Plan approval auto-starts implementation before plan review/registration is complete.
- A stale `review-pr` artifact is accepted after new commits.
- Stacked restack updates child before parent and creates avoidable conflicts.
- Ticket status transition failure blocks code delivery.
- Browser notifications are attempted before permission and create noisy errors.

### Adversarial Analysis

- **How could this fail in production?** The largest risks are data migration mistakes, wrong cwd launches, duplicate manager automation, stale plan/review gates, and provider/rate-limit failures.
- **What user actions trigger unexpected behavior?** Dirty worktrees during migration, manual git branch changes inside a checkout, closing tabs while runtime sessions should remain resumable, manually committing after review, and pausing automation mid-stack.
- **What existing behavior could break?** Current single-workspace navigation, workspace creation, PR display, terminal session restore, scheduled agents, auto-resume, and fix-conflicts routes all assume workspace path is a repo worktree.
- **Which tests credibly catch those failures?** Migration fixture tests, target-cwd unit tests, MCP path-validation tests, Playwright workspace tree/launch tests, and manager reducer tests for duplicate/idempotent decisions.
- **What gaps remain?** Real Jira/Linear workflow variance, real browser PWA notification behavior, long-running manager behavior over days, and complex stacked PR restacks will still need manual dogfooding.

## Tests

Implementation should follow TDD by unit:

1. Contracts and schemas.
2. DB migration and workspace/checkouts store methods.
3. Filesystem migration planner/executor.
4. Runtime launch-profile resolver.
5. Agent template storage/routes.
6. Execution-target session creation/history.
7. MCP context and role launchers.
8. Workspace plan versioning.
9. Manager reducer/state machine and gates.
10. Stack orchestration.
11. Web navigator/stage/Agents config components.
12. Playwright end-to-end flows.

## Schema or Contract Generation

No generated schema artifacts are currently known. If implementation adds generated OpenAPI/JSON schema output, include the repo-specific generation command in the PR and verification steps.

## Verification

Required before PR:

- `make check` — comprehensive architecture, typecheck, lint, unit, coverage, dependency, and build gate.
- `make e2e` — required because this changes cockpit navigation, launch UI, and workspace flows.
- `make smoke` — required because daemon HTTP/MCP/workspace APIs change.
- `make performance` — required because navigator/state payloads and manager heartbeat could affect startup/rendering hot paths.

## Suggested PR Slicing

The feature remains one product initiative, but implementation should land in reviewable PRs:

1. **Specs + contracts + DB migration foundation:** workspace root/checkouts, sessions target metadata, plan/version schemas. No manager automation yet.
2. **Workspace UI/navigation + migration:** root/Home/checkouts layout, existing workspace migration, target-scoped tabs/history.
3. **Runtime launch profiles + Agents config:** five predefined roles/actions, launch settings, model/effort/fast/context support, no custom agents.
4. **Role launchers + structured lifecycle:** PM bootstrap, architect handoff, plan registration/versioning, implementation/prototype launch rules.
5. **Manager v1 gates:** manager instance, pause, heartbeat, implementation completion, PR gates, review-pr artifacts.
6. **Stacked PR orchestration + restack:** dependency edges, stack creation, base update cascade, restack action.
7. **Issue provider/status + local notifications:** live child ticket reads, best-effort status updates, in-app/browser/sound notifications.

Each PR should keep the workspace usable and avoid exposing half-wired automation as if it were complete.
