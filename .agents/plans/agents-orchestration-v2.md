Activate the /implement-task skill first.

# Plan: Agents Orchestration V2

## Acceptance Criteria

### Manager Still Needs

- [ ] Event/tick loop: wake on workspace events plus a low-frequency backstop tick, then decide what to do next.
- [ ] Idempotent action ledger: dedupe “launch implementation”, “run review”, “restack”, “notify”, etc. by workspace/checkout/action key.
- [ ] Plan-to-work execution: read the active plan, identify delivery units, create/select checkouts, sequence dependencies, and launch the right agents.
- [ ] Review automation: detect implementation completion, run review-pr, invalidate stale review artifacts when PR head changes, and re-run after fixes.
- [ ] Stack orchestration: restack child branches when parent PRs move, with conflicts surfaced instead of hidden.
- [ ] Provider-backed issue sync: live parent/child issue reads, safe status transitions, and clear degraded behavior when provider data is unavailable.
- [ ] Readiness notifications: in-app/browser/sound notifications for ready_for_human_review and human_input_needed.
- [ ] Broader tests: manager state machine, idempotency, pause behavior, restack flow, stale provider facts, stale review artifacts.

### UI Still Needs

- [ ] A real Workspace Home view showing lifecycle, parent issue, discovery/readiness, active plan, manager pause state, manager decisions, and action history.
- [ ] Checkout detail surfaces: gate status, reasons, review artifact, deviation reports, PR identity/head/checks/mergeability, stack parent.
- [ ] Better structured navigation: visually separate Workspace Home from checkouts, show structured lifecycle/status badges, and aggregate attention states.
- [ ] Gate-aware launch UI: the plus menu exists, but it should clearly disable/explain unavailable role launches based on plan readiness, pause state, checkout state, and role rules.
- [ ] Specialized session affordances: PM/architect/implementation/prototype/manager sessions should be visually distinct from freestyle sessions.
- [ ] Stronger Agents config UX: validation, unsaved-change handling, runtime fallback display, edit/reset flows, and tested error states.
- [ ] Closed-session/history polish across Home and checkouts, including focus/close behavior and target-aware terminal/runtime cwd handling.
- [ ] E2E coverage for the full structured flow: create structured workspace, navigate Home/checkouts, configure agents, launch roles, pause manager, reach readiness, and inspect history.

## Context and problem statement

The current `fb-agents-orchestration-v2` branch has a good foundation for structured workspaces, but it is still mostly scaffolding:

- Contracts exist for `WorktreeCheckout`, role/action templates, workspace plan versions, managers, deviations, and review artifacts in `packages/contracts/src/agents-system.ts`.
- SQLite migration v16 plus follow-up v17/v18 creates `workspace_checkouts`, `workspace_plan_versions`, `workspace_managers`, `manager_events`, `plan_deviation_reports`, and `checkout_review_artifacts`.
- Operations can create a zero-checkout structured Workspace Home, create checkouts, resolve `cwd` to Home/checkouts, register workspace plans, pause/resume managers, evaluate a checkout gate, and record a simple ready notification.
- The daemon exposes MCP tools for role launch, plan registration, checkout gates, and manager controls.
- The cockpit renders workspace > Home/checkout rows, target-scoped tabs, a minimal structured role plus menu, and a small closed-session history.

The missing product value is the actual manager loop and the operational UI around it. Today there is no durable event/tick orchestrator, no first-class action claim/ledger, no parser that turns an approved plan into delivery units, no automated implementation/review/restack sequencing, no provider-backed child issue sync, and no complete Home/checkout detail surface. The next implementation should close those gaps without reworking the already shipped terminal transport or broad workspace migration foundation.

## Spec alignment

This work is aligned with the existing structured-workspace specs, but the specs need a small first-step tightening before implementation so downstream agents do not infer behavior from the current partial code.

| Area | Spec | Alignment / update needed |
|---|---|---|
| Product terms | `specs/A-shared-definitions.md` | Terms already exist. Update only if new persisted terms such as `Manager action ledger` and `Delivery unit` are added to contracts. |
| Workspace/checkouts | `specs/B.1-repositories-workspaces.md` | Aligned. Add delivery-unit binding fields and clarify that checkout creation from plans is manager-owned and idempotent. Track partial implementation with `[~]` markers until each rollout slice lands. |
| Cockpit UI | `specs/B.2-ade-cockpit.md` | Aligned. Expand Workspace Home and checkout detail requirements, launch-disabled explanations, and specialized session affordances. Track partial implementation with `[~]` markers until each rollout slice lands. |
| Agent sessions | `specs/B.3-agent-sessions-terminal.md` | Aligned. Tighten target-aware cwd and closed-session history expectations without touching terminal transport. |
| PR/review/restack gates | `specs/B.4-git-pr-ci-diff.md` | Aligned. Add review artifact invalidation fields and the `review-pr` artifact registration flow. Track partial implementation with `[~]` markers until each rollout slice lands. |
| Providers/config | `specs/B.6-providers-hooks-config.md` | Aligned. Clarify live parent/child issue reads, prompt snapshots, durable provider facts, transition attempts, and degraded issue-provider behavior. |
| Operations/MCP/manager | `specs/B.7-operations-activity-mcp.md` | Aligned but underspecified. Add event/tick loop, leased action ledger claim semantics, delivery-unit parser, plan supersession reducer, manager decision taxonomy, and human_input_needed notifications. |
| UI performance/E2E | `specs/B.8-ui-performance-quality.md` | Aligned. Add structured-flow E2E, deterministic fake runtime/provider support, and manager tick performance constraints. |
| Architecture | `specs/C-technical-stack.md` | Aligned. Confirm manager reducers/parsers stay pure and daemon wiring owns provider/agent side effects. |

Spec updates are the first implementation step. They should not change the product direction from the current plan; they should make the manager and UI completion details explicit. Because this is a multi-PR rollout, spec edits must use `[~]` for partially implemented behavior and each PR must update only the status markers it actually ships.

## Implementation approach

Implement a deterministic manager pipeline with a pure decision core and a daemon-side side-effect runner:

1. `packages/core` or a small pure module in `packages/operations` owns plan parsing, gate derivation, stack planning, launch-option derivation, and manager decision reducers. It must not call providers, git, tmux, Express, or the filesystem. Launch-option derivation must be shared by daemon and web through contracts/core, or returned authoritatively by the daemon, so UI and server preconditions cannot drift.
2. `packages/db` owns additive schema/state for parsed plan delivery units, manager action claims, review invalidation state, and store methods.
3. `packages/operations` owns manager orchestration services that read durable state, call checkout/session/worktree operations, and expose pure-ish methods for tests.
4. `apps/daemon` wires workspace events, the low-frequency tick, provider collectors, MCP tools, and SSE invalidation.
5. `apps/web` consumes typed daemon state only. It should not import daemon internals.

The central invariant is that every manager side effect is a claimable leased action with a stable idempotency key. Event delivery, ticks, and daemon restarts may repeat; repeated wakeups must only observe, reconcile incomplete side effects, update stale facts, or reuse/recover the already-claimed action.

## Alternatives considered

1. **Use `manager_events` as both action ledger and UI history.** Rejected. It is an immutable activity history with a unique idempotency key, but it cannot represent active claims, retries, related sessions/operations/artifacts, or status transitions cleanly.
2. **Let agents parse arbitrary Markdown delivery-unit prose every time.** Rejected. Plan-to-work execution needs deterministic delivery units. Approved structured plans should include a machine-readable block that the daemon validates and snapshots.
3. **Have implementation agents create review artifacts directly through `mark_checkout_ready_for_review`.** Rejected. That bypasses the required independent `review-pr` action. Implementation completion should register PR/head facts; review artifacts should come from the review action or a human override.
4. **Poll all providers on every tick.** Rejected. The manager should be event-first, use provider freshness/cooldown, and only refresh stale facts needed for active structured work.
5. **Build separate Home and checkout routes before fixing the stage.** Rejected. The existing target-scoped stage and navigator should be extended so Home/checkouts remain one workspace flow.

## Implementation steps

### 1. Specs and contracts

- Update the specs listed in Spec alignment before production code.
- Add contract schemas/types for:
  - `WorkspacePlanDeliveryUnit` and `WorkspacePlanDependencyEdge`.
  - `ManagerActionLedgerEntry`, including status, scope key, action key, fact key, `leaseOwnerId`, `leaseGeneration`, lease expiry, attempt count, related operation/session/artifact ids, PR head SHA, plan version, timestamps, and error.
  - `CheckoutGateSnapshot` as a serializable state/API shape, including reasons, freshness, current review artifact, stale review artifacts, deviations, and stack parent.
  - `StructuredLaunchOption` with `enabled`, `reason`, `severity`, `role`, `targetType`, `actionName`, and payload.
  - `LocalNotificationEvent` for `ready_for_human_review` and `human_input_needed`, including active/resolved/rearmed state, triggering fact fingerprint, resolved timestamp, and dedupe key.
  - `ProviderIssueFact` and `IssueTransitionAttempt` for durable parent/child issue reads and best-effort status transitions. Include provider instance/account id, host/external URL, workspace binding id, and source issue binding so issue keys cannot collide across provider instances.
  - `CheckoutPrFact` and `CheckoutCheckFact` for durable PR/head/check/mergeability/conflict facts used by gates and review automation. Include provider instance/account id, repository id/provider repo key, host/external URL, checkout id, and workspace binding id so PR numbers and check ids cannot collide across repos or hosts.
  - `AgentToolAuthority` for server-minted, session-scoped tool authority.
- Add contract-level validation helpers/schemas for plan-controlled git and filesystem identifiers:
  - Branch/ref fields must follow `git check-ref-format --branch` semantics and repo-local safety rules.
  - Checkout/worktree names must reject path separators, `..`, absolute paths, reserved names, control characters, empty/whitespace-only names, and provider-incompatible names.
  - Parsed delivery-unit keys, checkout names, and branches must be unique within the approved plan where collisions would make checkout selection ambiguous.
- Tighten `MarkCheckoutReadyForReviewInputSchema`: use it as implementation completion signal with PR/head facts and notes. Move review artifact creation into a new `RegisterCheckoutReviewArtifactInputSchema` or equivalent review-action-only tool.
- Extend review artifact contracts with `invalidatedAt`, `invalidatedReason`, and explicit human waiver fields.
- Extend workspace/checkouts contracts with delivery-unit identity: `deliveryUnitKey`, `deliveryPlanVersionId`, and optional manager status/freshness fields.
- Add server-derived actor/session context to side-effectful MCP/API contracts. Request bodies may identify targets, but they must not be trusted to declare `actor: "human"` or action ownership. Agent-facing tools must authenticate through an opaque per-session authority token or equivalent MCP connection context minted by the daemon at session launch.

### 2. Schema and store additions

Migration strategy:

| Operation | Classification | Notes |
|---|---|---|
| Create `workspace_plan_delivery_units` | Additive | Materialized snapshot of approved plan delivery units parsed at registration. |
| Create `workspace_plan_dependency_edges` | Additive | Stores dependency edges by plan version and delivery-unit key. |
| Add `delivery_unit_key` and `delivery_plan_version_id` to `workspace_checkouts` | Additive | Nullable for existing checkouts; indexed for idempotent manager selection. |
| Create unique partial index for active checkout delivery-unit claims | Additive | `workspace_id + delivery_plan_version_id + delivery_unit_key` where key is not null and checkout not archived. |
| Create `manager_action_ledger` | Additive | Durable leased claim table for launch/review/restack/notify/ticket actions, unique by idempotency key. Includes `status`, `lease_owner_id`, `lease_generation`, `lease_expires_at`, `attempt_count`, `max_attempts`, `operation_id`, `session_id`, `artifact_id`, `claimed_at`, `completed_at`, `last_reconciled_at`, and `error`. |
| Create `provider_issue_facts` | Additive | Durable provider-neutral issue facts for parent/child issues, including provider instance/account id, host/external URL, issue key/id, workspace binding id, title/status/acceptance snapshot, `fetched_at`, `stale_at`, degraded reason, cooldown metadata, and source binding. Unique keys must not collapse identical issue keys from different provider instances. |
| Create `issue_transition_attempts` | Additive | Durable history of manager/provider status transition attempts and degraded outcomes. |
| Create `checkout_pr_facts` | Additive | Durable checkout-scoped PR/head/base/mergeability/conflict facts with provider instance/account id, host/external URL, repository id/provider repo key, PR id/number/url, head SHA, base ref, `fetched_at`, `stale_at`, degraded reason, and cooldown metadata. Unique keys must include checkout/repo/provider identity, not just PR number. |
| Create `checkout_check_facts` | Additive | Durable check/CI facts for the current PR head, including provider instance/account id, repository id/provider repo key, PR/head binding, check name/id, status, conclusion, details URL, timestamps, and fetched/stale metadata. |
| Create `agent_tool_authorities` | Additive | Server-minted per-session authority records. Store token hash, session id, role/action, checkout id, plan version id, manager action id, issued/expiry/revoked timestamps, token TTL, revocation reason, and allowed tool names. |
| Add invalidation and waiver columns to `checkout_review_artifacts` | Additive | Old rows remain valid historical artifacts; current gate ignores stale head/invalidated rows. |
| Optionally add `manager_action_id` to `workspace_sessions` | Additive | Use only if needed to link launched sessions back to a ledger claim. |
| Insert `schema_migrations` row v19 `manager-orchestration-ledger` | Additive | Current code reports `CURRENT_SCHEMA_VERSION = 18`, so this plan uses v19. |

No destructive or rename operations are planned. Preserve `PRAGMA foreign_keys = ON;`. Existing operator databases get new empty tables and nullable columns on startup. Existing approved plans without parsed delivery units stay visible, but manager marks them `human_input_needed` until they are re-registered or manually parsed; no checkout or session is deleted.

Store methods to add or update:

- `insertWorkspacePlanDeliveryUnits`, `listWorkspacePlanDeliveryUnits`, and dependency-edge equivalents.
- `claimManagerAction`, `renewManagerActionLease`, `completeManagerAction`, `markManagerActionSuperseded`, `findManagerActionByKey`, `listManagerActions`, and `reconcileManagerActions`. Lease renew, side-effect preflight marking, completion, failure, supersession, and abandonment updates must compare-and-swap the current `leaseOwnerId + leaseGeneration` fencing token.
- `listCheckoutReviewArtifacts` with filters for current/stale/invalidated.
- `invalidateCheckoutReviewArtifacts(checkoutId, reason, headSha?)`.
- `updateWorkspaceCheckoutDeliveryUnit`.
- `upsertProviderIssueFact`, `listProviderIssueFacts`, `insertIssueTransitionAttempt`, and `listIssueTransitionAttempts`.
- `upsertCheckoutPrFact`, `listCheckoutPrFacts`, `upsertCheckoutCheckFacts`, and `listCheckoutCheckFacts`.
- `mintAgentToolAuthority`, `validateAgentToolAuthority`, `revokeAgentToolAuthority`, `revokeAuthoritiesForSession`, `revokeAuthoritiesForManagerAction`, and `listAgentToolAuthorities`.
- `listManagerEvents` and `listManagerActions` exposed through `/api/state`.

### 3. Plan parsing and registration

- Update the default PM and architect role/action templates so structured plans intentionally produce a machine-readable delivery-unit block. The architect prompt must describe the block, required fields, dependency edge types, child issue binding rules, and repair expectations.
- Add a plan validation preview in the plan registration/Home UI: parsed delivery units, dependency graph, dependency cycles/self-edges, unsafe branch or checkout names, missing/ambiguous repos, missing child issues, and manager-blocking errors must be visible before approval.
- Add a repair flow for invalid approved-plan attempts: keep the plan as `changes_requested` or `under_review`, show parser errors, and offer a launch/relaunch architect action with the validation errors included.
- Add a parser for a machine-readable fenced block in approved architect plans, for example:

~~~markdown
```json citadel.delivery_units.v1
{
  "deliveryUnits": [
    {
      "key": "api-gate",
      "repo": "citadel",
      "checkoutName": "api-gate",
      "branch": "fb-api-gate",
      "childIssue": { "provider": "jira", "key": "CIT-123" },
      "dependencies": []
    }
  ]
}
```
~~~

- Validate parsed units with Zod at `register_workspace_plan` time when status is `approved`.
- Reject dependency self-edges and cycles during plan registration. The parser must validate direct cycles, multi-node cycles, mixed dependency-edge cycles that can deadlock sequencing, and disconnected-but-acyclic valid graphs.
- Validate branch names, checkout/worktree names, and delivery-unit keys before approval. Branch validation should use `git check-ref-format --branch` semantics plus repo-local checks for existing branch collisions and ambiguous local/remote refs. Checkout/worktree names must be safe local names, not paths.
- Store the parsed snapshot in `workspace_plan_delivery_units` and dependency edges so later file edits do not silently change manager behavior.
- If a plan has the old required headings but no machine-readable block, registration can remain allowed as `draft` or `under_review`, but `approved` registration must return `plan_delivery_units_required`.
- Add a `human_input_needed` manager event if an already-active legacy plan cannot be parsed during a manager wake.

### 4. Manager event/tick loop

- Add `packages/operations/src/manager-decision.ts` for pure evaluation:
  - Input: workspace, manager, active plan, parsed delivery units, checkouts, sessions, gate snapshots, deviations, provider freshness, action ledger.
  - Output: ordered decisions such as `sync_issue`, `create_checkout`, `launch_implementation`, `launch_review_pr`, `restack_checkout`, `notify`, `human_input_needed`, or `noop`.
  - Include a plan-supersession reducer. When a new active plan appears, it must supersede pending old-plan actions, mark old-plan sessions/checkouts as plan-stale, map delivery units by stable key and child issue when safe, and emit `human_input_needed` when repo, branch, child issue, or dependency identity changed incompatibly.
- Add `apps/daemon/src/manager-orchestrator.ts` for side effects:
  - Subscribe to relevant app events: workspace updates, plan updates, checkout gate updates, agent status updates, PR/head/check/conflict updates, ticket updates, provider cooldown changes, and plan deviations.
  - Coalesce wakeups by workspace id.
  - Run a low-frequency backstop tick, default 5 minutes, only for active structured workspaces with running managers.
  - Skip automated side effects when global or workspace automation is paused, but still record local notifications and `human_input_needed`.
  - On daemon startup, reconcile ledger rows whose leases expired or whose related operation/session/artifact exists without a completed ledger update.
  - Emit SSE after manager decisions and action status changes.
- Wire orchestrator startup in `createDaemonApp`; tests should be able to disable the interval and invoke the tick deterministically.
- Manager gate/review decisions must consume durable `checkout_pr_facts` and `checkout_check_facts`, not only in-memory provider summaries or workspace-level PR caches. If durable PR/check facts are missing, stale, or degraded, the gate is blocked with a stale-provider reason.

### 5. Idempotent action ledger

- Implement action keys/fact keys for the required automated actions:
  - `launch_implementation`: workspace id + plan version + delivery-unit key.
  - `run_review_pr`: checkout id + active plan version + PR head SHA.
  - `restack_checkout`: checkout id + parent checkout/head SHA + base ref/head SHA.
  - `notify_ready_for_human_review`: checkout id + active plan version + PR head SHA.
  - `notify_human_input_needed`: workspace or checkout + reason key + active plan version + triggering fact fingerprint, with active/resolved/rearmed lifecycle state so the same condition can notify again after resolution.
  - `update_ticket_status`: canonical provider issue identity + requested internal state + triggering fact id/fingerprint. Canonical identity includes provider type, provider instance/account id, host/external URL, workspace binding id, source binding, stable issue id when available, and issue key.
- `claimManagerAction` must be atomic. A duplicate wake returns the existing ledger row and does not launch a second session or operation.
- Ledger states: `queued`, `claimed`, `running`, `succeeded`, `failed`, `blocked`, `superseded`, and `abandoned`.
- Every claimed/running action has `lease_expires_at`, `attempt_count`, and `max_attempts`.
- Every claimed/running action has a fencing token: `leaseOwnerId + leaseGeneration`. Renew, side-effect preflight, mutating side effects, completion, failure, supersession, and abandonment must compare-and-swap that token. A stale owner whose lease was reclaimed may only observe and must not complete or mutate the ledger.
- If the daemon crashes after claim but before recording a side effect, startup reconciliation checks for side effects by manager action id/idempotency key before retrying.
- If the daemon crashes after launching a side effect but before updating the ledger, reconciliation links the existing session/operation/artifact back to the ledger instead of launching again.
- Pass `managerActionId` and the idempotency key into session, checkout, review, notification, and ticket-transition creation. Side-effect creation must be idempotent on that value, not only on the manager ledger row.
- Action completion must record related operation id, session id, artifact id, status, error, lease release, and timestamps.
- Reconciliation must handle launched implementation sessions that exit without calling `mark_checkout_ready_for_review`: mark the implementation action `failed` or `blocked`, inspect durable PR facts only when a checkout PR binding exists, and emit `human_input_needed` with the exact missing completion signal.
- Retry policy: retry only actions whose lease expired and whose side effect is absent or safely retryable. Do not retry restack or branch update actions while the checkout is dirty, conflicted, or diverged; emit `human_input_needed` instead.
- Mirror concise operator-facing entries to `manager_events` and `activity_events`; use the ledger for dedupe and the event log for history.

### 6. Plan-to-work execution

- For each active approved plan delivery unit:
  - Resolve repository by explicit repo id, repo name, or provider URL according to the parsed schema.
  - Verify the workspace has a parent issue binding.
  - Verify exactly one child issue binding exists in the parsed unit and later on the selected checkout.
  - Create or select one checkout for the delivery unit. Existing checkouts win when they already carry `deliveryPlanVersionId + deliveryUnitKey`; otherwise match by child issue and checkout name only if unambiguous.
  - Store prompt snapshots with plan version, delivery unit, parent issue facts, child issue facts, and provider freshness/degraded notes.
- Sequence dependency edges:
  - `parallel`: start as soon as prerequisites for that unit pass.
  - `stacked_on_pr`: start after parent checkout is green, conflict-free, and reviewed for current head.
  - `wait_for_merge_or_release`: do not launch until provider reports the upstream condition complete.
  - `manual`: emit `human_input_needed` with the manual checkpoint reason.
- Launch implementation agents through the existing predefined role launcher with actor `manager`, not through freestyle session creation.
- On active plan supersession:
  - Supersede queued/pending actions tied to the old plan.
  - Notify active implementation/review sessions that their plan is stale.
  - Reuse existing checkouts only when the delivery-unit key and child issue still match, or when an explicit human mapping exists.
  - Require human input before changing a checkout's repo, branch strategy, stack parent, or child issue binding under an already-launched implementation session.

### 7. Review automation and stale artifact handling

- Change implementation completion flow:
  - `mark_checkout_ready_for_review` records a completion signal, PR identity/head/check facts, and notes.
  - It does not create a review artifact.
  - Manager verifies prerequisites and claims `run_review_pr`.
- Add a `register_checkout_review_artifact` MCP/API path for review-pr action sessions and human imports.
- Do not trust caller-supplied actor fields for artifact authority:
  - The daemon derives actor/source from the request path and server context.
  - Review action sessions are linked to a `manager_action_ledger` row at launch.
  - At managed session launch, the daemon mints an opaque per-session tool authority token, stores only its hash in `agent_tool_authorities`, scopes it to allowed tools/role/action/checkout/plan/manager action, and binds it to server-held MCP connection context.
  - Do not place raw authority tokens in shell-visible terminal environment variables. If a non-terminal runtime needs a token transport fallback, define the exact process boundary, keep it out of terminal shells, and add explicit redaction for process metadata/log capture.
  - Agent-facing MCP requests validate the token or connection context server-side and derive `sessionId`, role/action, checkout id, plan version id, and `managerActionId` from the stored authority. Body-supplied authority is ignored and mismatches are rejected.
  - Authority tokens must have short TTLs, constant-time hash validation, and explicit revocation on session close, action completion, plan supersession, lease abandonment, checkout archive, manager pause policy changes that invalidate the action, or daemon-admin revocation.
  - Raw authority tokens must never appear in `/api/state`, SSE payloads, logs, prompt snapshots, transcripts, terminal-visible metadata, review artifacts, or manager events. Store and display only derived session/action ids and redacted token status.
  - `register_checkout_review_artifact` accepts a review artifact only when the server can link the calling session to an active `implementation.review_pr` action for the same checkout/head/plan, or when a local human UI/admin route records an explicit import.
  - Human waivers and pause/admin controls are separate local UI/admin routes. Agent-facing MCP cannot submit human waivers or claim `actor: "human"`.
- Run `implementation.review_pr` in a separate managed session with target checkout cwd, active plan version, PR URL/head, delivery unit, and artifact registration instructions.
- On PR head SHA change, conflict fix, CI fix, restack, manual commit, or active plan mismatch:
  - Mark matching older artifacts invalidated with reason.
  - Revoke `ready_for_human_review` gate.
  - Claim a new `run_review_pr` action once PR facts are fresh, checks are green, and no conflicts exist.
- Human waivers must be explicit records. Manager/implementation/review agents cannot self-waive blocking findings.

### 8. Stack orchestration

- Add a pure stack planner that derives parent/child order from parsed dependency edges and checkout `stackParentCheckoutId`.
- For base branch movement:
  - Acquire a per-checkout/worktree operation lock before restack preflight. The lock must exclude other checkout-mutating operations and automated restacks for the same checkout.
  - Block automated restack when active mutating agent/terminal sessions exist in the checkout unless the active session is the managed restack/conflict action for the same ledger row.
  - Require a clean index and worktree before automated restack begins.
  - Create backup refs before any branch-rewriting update.
  - Re-check cleanliness, HEAD, and lock ownership immediately before each mutating git command.
  - Update the bottom checkout from the base branch first.
  - Then update each child checkout from its parent branch/head.
  - If a git command reports conflicts, stop that branch of the cascade, set gate `conflicts` or `needs_restack`, record an operation, and launch the configured conflict/restack action only when unpaused.
- Do not force-push by default. Any future force-push policy must be explicit, logged, and human-approved.
- If the checkout has dirty files, unpushed commits unrelated to the planned restack, divergent local history, or an unresolved conflict state, do not mutate the branch. Record `human_input_needed` with the reason and show it in Home/checkout UI.
- For upstream PR movement:
  - Mark descendants `needs_restack`.
  - Re-run restack from the changed parent downward.
- Surface force-push, upstream branch deletion, manual rebase divergence, partial stack failure, and stale provider state as explicit reasons. Do not hide them behind success states.

### 9. Provider-backed issue sync

- Add a provider-neutral issue sync service wired in the daemon:
  - Jira uses existing shell-backed collectors first.
  - Future providers fit behind the same issue summary/transition contracts.
- Add a checkout PR/check fact sync service wired in the daemon:
  - GitHub uses existing `gh`-backed PR/check collectors and checkout PR binding.
  - Future PR/CI providers fit behind the same PR fact/check fact contracts.
  - Facts are stored in `checkout_pr_facts` and `checkout_check_facts` before manager gates consume them.
- Live reads:
  - Parent issue summary is refreshed for structured workspaces with parent bindings.
  - Child issue summaries are refreshed for plan delivery units/checkouts.
  - Store provider instance/account id, host/external URL, workspace binding id, issue key/id, fetched title/status/acceptance snapshot, `fetchedAt`, `staleAt`, provider status, cooldown/rate-limit metadata, and degraded reason in `provider_issue_facts`.
  - Link facts back to workspace parent bindings, checkout child bindings, and plan delivery units without making provider facts the planning source of truth.
  - Checkout PR/head/check/mergeability/conflict facts are refreshed for implementation checkouts with intended PR bindings and stored durably before readiness evaluation.
  - PR/check fact keys include provider instance/account id, repository id/provider repo key, checkout id, PR id/number/url, and head SHA where applicable; same PR numbers in different repos or hosts must remain distinct facts.
- Degraded behavior:
  - Unconfigured/unhealthy/rate-limited issue provider leaves local bindings visible.
  - Unconfigured/unhealthy/rate-limited PR/CI provider leaves last-known PR/check facts visible but stale/degraded.
  - Prompt snapshots and UI show provider facts as stale/unavailable.
  - Manager emits `human_input_needed` only when provider unavailability blocks a required binding/freshness check; best-effort status transition failures remain warnings.
- Safe status transitions:
  - Resolve available transitions live.
  - Skip idempotently when already in the target state.
  - Record every attempt in `issue_transition_attempts` with requested internal state, current external status, selected transition, resulting external status, success/failure, degraded reason, manager action id, and timestamp.
  - Never block code delivery solely because transition failed.

### 10. Readiness notifications

- Treat `ready_for_human_review` and `human_input_needed` as local notification event types.
- Server side:
  - Record notification decisions in manager action ledger and manager events with active/resolved/rearmed lifecycle state and triggering fact fingerprint.
  - Mark notification facts resolved when the blocking condition clears, and rearm them when the same reason recurs with a new triggering fact or after a resolved state.
  - Include notification events in `/api/state` or a dedicated notifications endpoint.
  - Emit SSE for new notification decisions.
- Web side:
  - In-app alert/toast for both event types.
  - Browser notification support is required, with permission-request, permission-denied, unsupported-browser, and notifications-disabled states.
  - Sound notification support is required, with an operator toggle, disabled state, and safe failure handling if playback is blocked.
  - Dedupe displayed notifications by server idempotency key.
- Do not add Slack/Teams/email providers in this plan.

### 11. Workspace Home and checkout UI

- Add target overview components in `apps/web/src/`:
  - `workspace-home-view.tsx`: lifecycle phase, parent issue, discovery/readiness, active plan, plan versions, manager pause state, manager decisions, action ledger/history, and next actions.
  - `checkout-detail-view.tsx`: gate status, gate reasons, delivery unit, child issue, PR identity/head/checks/mergeability, current/stale review artifact, deviation reports, stack parent/children, and action history.
- Add shared launch-option derivation:
  - Prefer a daemon-provided `structuredLaunchOptions` field or endpoint generated from the same pure function used by MCP/daemon preconditions.
  - If a client-side helper is still useful for optimistic rendering, put the pure derivation in `packages/core` or contracts-compatible shared code and import it from both daemon/web. Do not duplicate the rules in `apps/web` only.
- Render Home or checkout detail in the Stage empty state and as a compact target summary near the tab strip so the selected target is useful before any terminal is open.
- Extend `/api/state` to include manager actions, manager events, review artifacts, parsed delivery units, and checkout gate snapshots, or add a focused `/api/workspaces/:id/structured-state` endpoint if `/api/state` payload gets too large.
- Keep visible language product-facing: Home, checkout, plan, review, ready, blocked, paused. Do not expose raw provider dumps or prompt bodies.

### 12. Structured navigation and launch UI

- Improve navigator rows:
  - Visually separate Home from checkouts.
  - Show lifecycle, manager pause/attention, gate status, PR/review artifact status, child issue, and stack parent badges.
  - Aggregate workspace attention from checkouts, manager actions, human_input_needed, stale providers, conflicts, and review findings.
  - Preserve stable row heights.
- Replace `structuredStageActions` with authoritative structured launch options:
  - Home: PM, Architect, Manager, Terminal, freestyle runtimes.
  - Checkout: Implementation, Prototype, Terminal, freestyle runtimes.
  - Disabled options include exact reason text for plan missing, discovery not ready, automation paused, checkout missing child ticket, provider stale/unavailable, wrong target type, session cap, runtime unhealthy, and lifecycle creating.
  - Human manual launches remain possible while manager automation is paused when specs allow it, but the menu shows that manager follow-up is paused.
- Specialized tabs/history:
  - Use role-specific icon/color/label treatment for PM, Architect, Implementation, Prototype, Manager, and role actions.
  - Freestyle sessions remain visually plain and untracked.
  - Closed-session history groups by target and preserves focus after close.

### 13. Agents config UX

- Harden `AgentTemplatesPanel`:
  - Validate runtime selection, model, effort, fast mode, and context mode against current launch capabilities.
  - Show runtime fallback warnings and stale capability timestamps.
  - Block save when required fields are invalid.
  - Preserve unsaved changes when switching role/action, with a discard/save confirmation path.
  - Handle stale `updatedAt` conflicts with a reload/overwrite choice.
  - Add reset confirmations and visible reset-to-default result.
  - Render tested empty/error states for no runtimes, runtime unhealthy, template load failure, save failure, reset failure, and stale-write conflict.
- Do not reintroduce custom agent CRUD.

### 14. Closed-session and target-cwd polish

- Verify terminal and agent session creation always passes `targetType` and `checkoutId` where applicable.
- Fix global shortcut session creation so it respects the selected target, not only workspace id.
- On tab close:
  - Kill tmux and mark `closedAt`.
  - Preserve runtime session id, role/action metadata, plan version, target, and manager action link.
  - Focus left sibling, then right sibling; if no live sessions remain, show the target detail view.
- History should list closed/restorable sessions across Home and checkouts without mounting terminal renderers.

### 15. Feature exposure and rollout

- Keep manager automation hidden or explicitly preview-labeled until plan parsing, action ledger, gate evaluation, and UI explanations are all wired.
- Do not expose a launch option that calls an endpoint likely to fail without explaining the precondition in the menu.
- Use existing runtime/terminal transport; this plan should not modify low-level xterm, node-pty, tmux attach, raw input, paste, resize, alternate screen, or reconnect behavior.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|---|---|---|
| Unit (Vitest) | Tests must be added and updated | Required for contracts, schema/store methods, plan parsing, manager decisions, action idempotency, gate snapshots, review invalidation, restack planning, issue sync degradation, launch-option derivation, Agents config validation, Home/checkout components, and session history/focus utilities. |
| E2E (Playwright) | Tests must be added | Required because the feature changes the structured workspace operator flow: create workspace, navigate Home/checkouts, configure agents, launch roles, pause manager, reach readiness, receive local notification, and inspect history. |

### New tests to add

- `packages/contracts/src/agents-system.test.ts`: parses delivery units, dependency edges, branch/ref and checkout-name validation helpers, manager action ledger entries with lease fencing fields, local notification lifecycle fields, review artifact invalidation/waiver fields, checkout gate snapshots, and structured launch options.
- `packages/db/src/migration.test.ts`: v19 migration creates delivery-unit tables, dependency-edge tables, manager action ledger, nullable checkout delivery-unit columns, review invalidation columns, and preserves existing data.
- `packages/db/src/agents-system-store.test.ts`: action ledger claim/update/lease/reconciliation idempotency, lease fencing compare-and-swap, stale owner completion rejection after reacquisition, parsed delivery-unit round trip, checkout delivery-unit uniqueness, durable provider issue facts with same issue keys across provider instances, durable PR/check facts with same PR numbers across repos, issue transition attempts with canonical provider identity, agent tool authority lifecycle/revocation, review artifact invalidation, waiver fields, and manager event listing.
- `packages/operations/src/workspace-plan-parser.test.ts`: valid `citadel.delivery_units.v1` block, missing block, duplicate keys, invalid dependency target, dependency self-edge, direct cycle, multi-node cycle, mixed-edge cycle, disconnected valid graph, invalid branch/ref, unsafe checkout/worktree name, existing branch collision, ambiguous local/remote ref, mixed providers, ambiguous repo, and old plan degraded path.
- `packages/operations/src/manager-decision.test.ts`: event/tick decisions for create checkout, launch implementation, run review, notify ready, notify human input, pause behavior, active action reuse, stale provider facts, stale review artifact, plan supersession, and stale-session notification.
- `packages/operations/src/manager-idempotency.test.ts`: duplicate event plus tick delivery creates one checkout/session/review/restack/notification/ticket transition per idempotency key; crash recovery relinks existing side effects instead of duplicating them; stale lease owners cannot complete after another owner reacquires; implementation session exit without completion becomes blocked/failed and emits `human_input_needed`; two provider instances with the same issue key produce distinct ticket transition actions.
- `packages/operations/src/manager-authorization.test.ts`: server-derived actor/source, opaque per-session tool authority validation, short TTL expiry, revocation on close/completion/supersession/abandonment/archive, no raw token in terminal shell environment, token redaction from logs/state/prompts/transcripts, review artifact action ownership, human waiver UI-only path, pause-control spoof rejection, and agent-callable manager launch restrictions.
- `packages/operations/src/checkout-gates.test.ts`: current head reviewed, old head stale, invalidated artifact ignored, blocking findings, human waiver, conflicts after readiness, checks pending/failing, stale provider facts, and open deviations.
- `packages/operations/src/stack-orchestration.test.ts`: parallel vs stacked vs wait-for-merge vs manual edges, parent-before-child restack order, clean-worktree precondition, backup refs, no default force-push, dirty/diverged human input, upstream deletion, manual rebase, partial failure, and conflict surfacing.
- `packages/operations/src/checkout-operation-locks.test.ts`: per-checkout lock acquisition/release, active mutating session detection, re-check before each git mutation, and lock cleanup after failure.
- `apps/daemon/src/manager-orchestrator.test.ts`: event coalescing, low-frequency tick, no provider-heavy work while paused/inactive, action claim around side effects, SSE invalidation, and disabled interval in tests.
- `apps/daemon/src/issue-sync-routes.test.ts` or `apps/daemon/src/manager-issue-sync.test.ts`: Jira healthy read, provider unavailable, rate-limited stale data, same issue key across provider instances/accounts, transition skip when already target status, unresolved transition, canonical transition action key identity, and degraded transition warning.
- `apps/daemon/src/checkout-pr-facts.test.ts`: GitHub healthy PR/check refresh, provider unavailable/rate-limited stale facts, same PR number across different repos/hosts, head SHA change persistence, check conclusion persistence, mergeability/conflict persistence, and gate consumption of durable facts only.
- `apps/daemon/src/daemon-mcp-tool.test.ts`: `mark_checkout_ready_for_review` no longer creates review artifacts, `register_checkout_review_artifact` requires server-linked review action/human context, and pause/actor fields cannot be spoofed by agent-callable launchers.
- `packages/core/src/structured-launch-options.test.ts` or `packages/operations/src/structured-launch-options.test.ts`: every disabled/enabled role reason across Home, checkout, plan readiness, pause, checkout state, role target rules, runtime health, and session cap.
- `apps/web/src/workspace-home-view.test.tsx`: lifecycle, parent issue, readiness, active plan, manager pause, manager decisions, action history, and human_input_needed display.
- `apps/web/src/workspace-plan-validation.test.tsx`: delivery-unit preview, parser errors, missing repo/child issue display, repair architect action, and approval blocking.
- `apps/web/src/checkout-detail-view.test.tsx`: gate reasons, current/stale review artifact, deviations, PR head/checks/mergeability, stack parent/children, and action history.
- `apps/web/src/navigator-structured-status.test.tsx`: Home/checkouts separation, structured badges, aggregate attention, stable row labels.
- `apps/web/src/agent-templates-panel.test.ts`: validation, unsaved-change guard, fallback display, stale-write conflict, reset flow, save error, no-runtime state, runtime-unhealthy state.
- `apps/web/src/stage.test.tsx`: specialized role tab affordances, freestyle distinction, close focus fallback, target detail empty state, target-aware shortcut launches, cwd selection, attach/restore metadata, close/kill behavior, reconnect display, and selected-target shortcut behavior.
- `apps/web/src/local-notifications.test.tsx`: in-app notification, browser permission request/denied/unsupported states, sound enabled/disabled/playback-failed states, server-key dedupe, active/resolved/rearmed lifecycle, stale provider restored then stale again, and conflict resolved then recurring.
- `packages/testing/src/structured-flow-fakes.test.ts`: fake runtime/provider/review fixtures expose deterministic PR, issue, transition, and review outcomes for Playwright.
- `e2e/structured-flow.spec.ts`: with fake runtime/provider/review hooks and deterministic manager tick controls, create structured workspace, navigate Home/checkouts, configure Agents, launch PM/Architect/Prototype/Implementation with gate explanations, pause manager, reach readiness notification, and inspect closed history.

### Existing tests to update

- `packages/contracts/src/index.test.ts`: workspace/session schema expectations for target-aware sessions and manager action links.
- `packages/db/src/migration.test.ts`: update `CURRENT_SCHEMA_VERSION` expectations from v18 to v19.
- `packages/operations/src/workspace-manager.test.ts`: split implementation completion from review artifact registration; add stale artifact and pause coverage.
- `packages/operations/src/workspace-plans.test.ts`: approved plan validation now requires delivery-unit block.
- `packages/operations/src/structured-workspace.test.ts`: assert manager starts with no queued automated actions until plan/discovery facts exist.
- `apps/daemon/src/structured-role-launchers.test.ts`: launch option and pause semantics stay aligned with manager action ledger.
- `apps/daemon/src/agent-templates-routes.test.ts`: validation and stale-write errors for role/action template updates.
- `apps/daemon/src/state-route.test.ts` or existing app state tests: include manager actions/events, review artifacts, delivery units, and gate snapshots.
- `apps/web/src/app-state.test.ts`: optimistic removal filters new structured state arrays.
- `apps/web/src/navigator.test.ts`: structured badges and aggregate attention.
- `apps/web/src/agent-templates-panel.test.ts`: extend from happy path to validation/error states.
- Existing PR/conflict E2E (`e2e/pr-conflicts.spec.ts`, `e2e/pr-display.spec.ts`) should assert checkout-level gates when structured checkout state is present.
- Existing spec-focused tests should assert status markers do not claim `[x]` for behavior that remains preview/partial in a slice.

### Assertions to add/change/tighten

- Replaying the same manager wake does not duplicate sessions, checkouts, reviews, restacks, notifications, or ticket transitions.
- Expired ledger leases reconcile existing side effects before retrying and never launch duplicates after daemon restart.
- A stale ledger lease owner cannot renew, mutate side-effect state, complete, fail, supersede, or abandon an action after another owner has reclaimed the lease generation.
- Server-derived actor/session context prevents agents from spoofing human waivers, review artifacts, pause controls, or manager-owned action claims.
- Plan supersession supersedes old pending actions, marks in-flight sessions stale, and requires human input for incompatible delivery-unit changes.
- Durable provider issue facts survive daemon restart and stale/degraded facts do not satisfy readiness.
- Durable PR/head/check/mergeability facts survive daemon restart and stale/degraded PR facts do not satisfy readiness.
- Agent-facing MCP tools reject missing, expired, mismatched, or body-supplied authority tokens.
- Authority tokens are revoked on session/action/supersession/abandonment/archive boundaries and are redacted from state, logs, prompts, transcripts, SSE, terminal metadata, artifacts, and events.
- Authority tokens are not injected into shell-visible terminal environments.
- Plan-producing templates and plan validation UI produce/preview/repair the required `citadel.delivery_units.v1` block before approval.
- An approved structured plan without machine-readable delivery units does not start implementation and surfaces `human_input_needed`.
- Plans with dependency self-edges, cycles, unsafe checkout names, invalid branch refs, branch collisions, or ambiguous local/remote refs cannot be approved.
- A delivery unit without exactly one child issue binding does not launch implementation.
- An implementation session that exits without calling `mark_checkout_ready_for_review` becomes blocked/failed with `human_input_needed`, not an indefinitely running manager action.
- A paused manager records decisions but does not perform automated launches/restacks/reviews/ticket transitions.
- Human manual launches while paused follow spec behavior and display paused follow-up messaging.
- `mark_checkout_ready_for_review` cannot satisfy review readiness by itself.
- A review artifact for a prior head SHA is visible as stale but does not satisfy the gate.
- Conflict or head change after readiness revokes readiness and claims the appropriate follow-up action.
- Restack updates parents before children and stops visibly on conflicts.
- Restack refuses dirty/diverged checkouts, creates backup refs before branch rewriting, and never force-pushes by default.
- Restack holds a per-checkout lock, blocks when unrelated mutating sessions are active, and re-checks cleanliness before each git mutation.
- Provider-unavailable issue reads keep local bindings visible and mark facts degraded/stale.
- Same issue keys across provider instances and same PR numbers across repos/hosts remain distinct durable facts.
- Ticket transition action keys use canonical provider issue identity, so same issue keys across provider instances/accounts do not dedupe each other.
- Ticket status transition failures record warnings and do not block delivery.
- Browser/sound notifications are permission-gated and deduped by server event key.
- `human_input_needed` notifications can resolve and rearm when the same reason recurs with a new triggering fact or after the condition clears.
- Browser notification and sound implementations exist even when permission is denied or sound is disabled; those states are explicit and tested.
- Web launch options are derived from the same rules as daemon/MCP preconditions.
- No web code imports daemon internals.

### Failure modes / edge cases / regression risks

- Manager loops duplicate actions because event and tick wakeups race.
- Daemon crash leaves a claimed action stuck or relaunches an already-created side effect.
- Stale ledger owner writes completion after its lease was reclaimed by another worker.
- Agent-callable MCP input spoofs human/review authority if server context is not enforced.
- Agent tool authority token leaks or is accepted for the wrong session/action/checkout.
- Agent tool authority token is exposed through shell-visible terminal environment.
- Agent tool authority stays valid after session close, action completion, plan supersession, or checkout archive.
- New active plans orphan old actions or keep old implementation sessions running against stale instructions.
- Plan parser accepts ambiguous delivery units and launches in the wrong repo/checkout.
- Plan parser accepts dependency cycles or self-edges and deadlocks launch/restack sequencing.
- Plan parser accepts unsafe branch or checkout names and later creates invalid refs or unsafe worktree paths.
- Existing active plans become silently ignored after stricter parsing.
- Implementation session exits without a completion signal and leaves manager action stuck as running.
- Implementation agents can still create fake review artifacts.
- Review artifact appears current in the UI even after a new commit.
- Stale provider facts accidentally satisfy readiness.
- Stale PR/check facts accidentally satisfy readiness after daemon restart.
- Provider facts are memory-only and lose degraded/stale state after restart.
- Durable facts collide across provider instances, repos, or hosts and unblock the wrong checkout.
- Ticket transition action keys collide across provider instances with the same issue key.
- Restack automation hides conflicts, mutates dirty/diverged branches, or rebases child before parent.
- A user or agent mutates a checkout between restack preflight and the git command.
- Ticket provider transition names differ from target statuses.
- Pause semantics either block too much human work or fail to block automated work.
- Notifications become noisy because browser and in-app paths do not share idempotency keys.
- Notifications fail to reappear after a stale provider or conflict condition is resolved and later recurs.
- Target-scoped launches use workspace Home cwd when the selected checkout should be used.
- Agents config loses unsaved edits when switching roles.
- Architect plans repeatedly fail approval because templates/UI never surface the required delivery-unit block.

### Adversarial analysis

- **How could this fail in production?** The main risks are duplicate side effects, stale lease owners writing after reclamation, stuck leased actions after crashes or missing completion signals, spoofed/leaked/stale agent authority, stale or misbound PR/review/provider facts and ticket transitions, incorrect plan parsing, unsafe refs/worktree names, unsafe restacks, provider outages, and UI affordances that imply automation happened when it was blocked.
- **What user actions could trigger unexpected behavior?** Manual commits after review, force-pushing a parent PR, pausing automation mid-run, switching active targets then using keyboard shortcuts, editing Agents config with stale data, and re-registering a plan while implementation sessions are active.
- **What existing behavior could this break?** Target-scoped sessions, existing workspace migration, PR display, Jira auto-transitions, terminal close/restore, global shortcuts, and Agents config happy paths.
- **Which automated tests would credibly catch those failures?** Manager idempotency/session-exit/lease-fencing reconciliation tests, authorization spoofing/token lifecycle/redaction tests, parser graph/ref/name validation tests, plan-supersession tests, gate reducer tests backed by durable PR/check facts, fact and ticket-action identity collision tests, stack planner and checkout-lock safety tests, durable issue sync degradation tests, shared launch-option unit tests, plan validation UI tests, notification rearm tests, terminal/session lifecycle tests, component tests for Home/checkout details, and the deterministic structured-flow Playwright test.
- **What gaps remain?** Real multi-day manager behavior, real Jira workflow variance, complex GitHub stack edge cases, and browser notification behavior across PWA/browser modes still need dogfooding after automated coverage.

## Tests

TDD order:

1. Contracts for delivery units, manager actions, gate snapshots, launch options, and review invalidation.
2. DB migration/store tests for v19.
3. Plan parser, dependency graph, branch/ref/name safety, and approved-plan registration tests.
4. Manager decision reducer, plan supersession, leased action ledger fencing, and crash/session-exit reconciliation tests.
5. Authorization, session authority token lifecycle/redaction, and spoofing tests for MCP/API action ownership.
6. Durable PR/check fact tests and gate/review artifact invalidation tests.
7. Stack planner, checkout operation lock, and restack safety tests.
8. Durable issue provider sync degradation tests.
9. Daemon orchestrator/MCP wiring tests.
10. Shared launch-option derivation tests.
11. Plan-producing template and plan validation UI tests.
12. Workspace Home and checkout detail component tests.
13. Local notification component tests.
14. Agents config UX tests.
15. Stage/history/focus target-cwd and terminal/session lifecycle tests.
16. Deterministic fake runtime/provider/review fixtures.
17. Structured-flow Playwright E2E.

## Schema or contract generation

No generated schema artifacts are known. This plan changes Zod contracts and SQLite schema only. If the implementation adds generated API artifacts, document and run the generation command in the PR before verification.

## Verification

Required before PR:

- `make check` - comprehensive architecture, typecheck, lint, unit, coverage, dependency, and build gate.
- `make e2e` - required because the structured workspace cockpit flow and launch UI change.
- `make smoke` - required because daemon HTTP/MCP/workspace APIs and manager orchestration change.
- `make performance` - required because manager ticks, `/api/state` payloads, and structured navigator rendering can affect hot paths.

## Hard gate commitments

- **Spec gate:** Applies. This plan implements new structured-workspace behavior and closes feature gaps, so spec updates with partial-status markers must land before production code and each PR must update only the markers it actually ships.
- **Regression test gate:** Applies. This plan fixes orchestration, provider, review, restack, notification, and UI gaps; implementation must add or extend the unit/E2E tests listed above before the relevant production behavior ships.
- **Architecture-boundary gate:** Applies. Keep pure decision logic free of daemon/provider/terminal imports; web imports contracts/API clients only; extend `scripts/checks/architecture-boundaries.ts` if a new boundary appears.
- **Schema-safety gate:** Applies. All v19 operations are additive, including delivery-unit tables, leased action ledger, durable provider issue facts, durable PR/check facts, transition attempts, agent tool authorities, and review invalidation columns. No DROP, destructive change, or rename is planned. Preserve `PRAGMA foreign_keys = ON;`.
- **File-size gate:** Applies. Split new manager orchestrator, decision reducer, parser, stack planner, Home view, checkout detail, and Agents config helpers into focused files. Do not create or grow non-generated source files beyond 800 lines.
- **Provider-degradation gate:** Applies. Issue, PR, and check provider facts must persist stale/unavailable states and must not satisfy readiness when stale. Transition failures are durable warnings, not delivery blockers.
- **Workspace-cleanup-safety gate:** Applies only for checkout/restack/worktree operations. Do not delete dirty worktrees. Do not mutate dirty/diverged restack branches. Hold per-checkout locks, block unrelated active mutating sessions, re-check before each mutation, create backup refs before branch rewriting, and never force-push by default.
- **Terminal-completeness gate:** Applies in narrowed form for session lifecycle work because this plan changes target-aware cwd, shortcut launches, close/kill, restore history, and reconnect display. Add targeted terminal/session lifecycle tests for cwd, attach/restore metadata, close/kill, reconnect, and selected-target shortcuts. If any change touches `packages/terminal`, node-pty/xterm input, paste, resize, alternate screen, or raw terminal routing, expand to the full terminal fidelity tests required by the spec.
- **Lockfile-sensitivity gate:** Skipped unless dependencies change. No new dependency is expected; use existing React, TanStack Query, lucide, Zod, Vitest, and Playwright.

## Suggested PR slicing

1. Specs with partial-status markers, contracts, v19 schema, store methods, durable issue/PR/check fact identity, canonical ticket action identity, agent tool authorities, and plan parser with graph/ref/name validation.
2. Manager decision reducer, plan supersession, leased action ledger fencing, crash/session-exit reconciliation, gate snapshots, review artifact invalidation, and checkout operation locks.
3. Daemon manager orchestrator, event/tick loop, server-derived actor context with opaque session authority lifecycle/redaction and non-shell-visible transport, MCP/API review artifact registration, issue sync, and PR/check fact sync.
4. Plan-producing template updates, plan validation UI for dependency/ref/name errors, plan-to-work execution, implementation launch sequencing, provider-backed prompt snapshots, and stale-plan session notification.
5. Review automation and required local notifications, including notification resolve/rearm lifecycle, browser permission states, and sound toggle/playback states.
6. Stack orchestration and restack conflict surfacing.
7. Workspace Home, checkout detail, structured navigation badges, and gate-aware launch UI.
8. Agents config UX and closed-session/history polish with targeted terminal/session lifecycle coverage.
9. Structured-flow E2E plus smoke/performance hardening.
