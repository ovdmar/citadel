Activate the /implement-task skill first.

# Plan: Merge conflict detection + fix-conflicts loop

Source: scratchpad block `00000008-0008-4008-8008-000000000008`.
Branch: `agent/08-merge-conflicts-l0bg4m` (set by the parent orchestrator; deviates from the repo's `fb-*` convention but kept because the parent orchestration scheme uses `agent/<NN>-*` to map 10 parallel agents back to scratchpad topic numbers, and the repo is pre-public so direct-push convention applies).
Target PR count: **one PR** with three clearly separated commits, one per slice. Landing as three sequential PRs was considered but rejected — see Alternatives.

## Acceptance Criteria

- [ ] **AC1 — Detection.** `gh pr view` is queried for `mergeable` and `mergeStateStatus`; both flow through to `PullRequestSummary` in `@citadel/contracts` and reach the web UI.
- [ ] **AC2 — UI tone.** `prToneFor` returns a new `"conflicting"` tone (rendered with danger color) whenever `pr.mergeable === "CONFLICTING"` OR `pr.mergeStateStatus === "DIRTY"`, taking precedence over the existing `failing`/`pending`/`passing` branches (but NOT over `merged`).
- [ ] **AC3 — Readiness.** A new `pr-conflicts` readiness state (danger tone) is emitted when the PR is mergeable=CONFLICTING. It is distinct from the local-`conflicts` state. Ordering: `blocked` → local `conflicts` → `pr-conflicts` → `checks-failing` → `waiting-provider` → `dirty` → `ready-to-merge`. When `pr-conflicts` fires, `reasons[]` MUST still include the failing-check reason if CI is also red, so the inspector surfaces both. `ready-to-merge` is gated on `pr.mergeable !== "CONFLICTING"`.
- [ ] **AC4 — Fix-conflicts button.** When readiness is `pr-conflicts`, the inspector stats panel renders a "Fix conflicts" button. Clicking always launches a **new** agent session against the workspace (no 409 / deduplication — by design, per the grilling round's "always launch new" choice).
- [ ] **AC5 — Hook override.** If `<workspacePath>/.citadel/hooks/fixconflicts` is executable, its stdout (capped at 32 KB) is used as the prompt body instead of the hardcoded default. Falls back gracefully when missing or non-executable.
- [ ] **AC6 — CI auto-recovery.** When a workspace's PR has `checks-failing` AND no agent session has been active for ≥5 minutes AND we have not already auto-pinged for the current PR head SHA AND we have not auto-pinged within the last debounce window, a dedicated daemon tick launches a new agent with a "fix CI" prompt. Per-SHA dedupe + debounce state reset semantics defined in the Migration strategy + decide-function spec.
- [ ] **AC7 — Auto-recovery guardrails.** Auto-recovery is configurable (env-flag-disable + idle-threshold + debounce), is invoked from a dedicated low-frequency daemon tick (not the cockpit GET path), is cheap to compute, and only fires for workspaces with an agent runtime configured.
- [ ] **AC8 — Activity provenance.** Auto-launched agent sessions emit an activity event with `source: "automatic-rule"` (per `ActivityEvent.source` enum in `@citadel/contracts`), distinguishing them from user-initiated launches.

## Context and problem statement

Citadel currently surfaces three PR-adjacent failure modes in readiness: failing CI checks, local working-tree conflicts, and review state. It does **not** surface PR-level merge conflicts (i.e., the branch has diverged from main such that GitHub reports `mergeable: CONFLICTING`). The user can have a PR that is approved, all checks green, and still cannot be merged — Citadel currently calls that `ready-to-merge`, which is wrong.

Beyond detection, the user wants two automated remediation loops:

1. A "Fix conflicts" button on the inspector stats panel — one click launches a fresh agent with a prompt that walks it through resolving the conflict against main, respecting Citadel's non-FF push policy.
2. An idle-agent CI-failure auto-recovery loop — when CI is red and no agent has been working for a while, citadel proactively launches a fresh agent to investigate. Bounded by per-SHA dedupe + debounce so we don't ping forever for the same unfixable commit and don't re-fire on a single same-SHA CI re-run.

The detection plumbing is mechanical; the design surface is the agent-launch trigger, prompt body, and dedupe/debounce state. The hook framework for `fixconflicts.prompt` override is a thin file-existence check + spawn — does not require the broader #11 hooks framework to ship.

## Spec alignment

Mapping per the repo's spec-glob convention (`.agents/skills/extensions/review-pr.md`):

| Touched code | Spec(s) |
|---|---|
| `packages/providers/src/index.ts` | `B.4-git-pr-ci-diff.md`, `B.6-providers-hooks-config.md` |
| `packages/contracts/src/index.ts` (PR summary, readiness state) | `A-shared-definitions.md`, `B.4-git-pr-ci-diff.md` |
| `apps/web/src/workspace-card.tsx`, `apps/web/src/inspector*.tsx` | `B.2-ade-cockpit.md`, `B.8-ui-performance-quality.md` |
| `apps/daemon/src/readiness.ts`, `apps/daemon/src/app.ts`, new `apps/daemon/src/auto-recovery.ts` | `B.1-repositories-workspaces.md`, `B.2-ade-cockpit.md`, `B.4-git-pr-ci-diff.md`, `B.7-operations-activity-mcp.md` |
| `packages/hooks/src/fix-conflicts.ts` (new) | `B.5-apps-links-actions.md`, `B.6-providers-hooks-config.md` |
| `packages/db/src/migrate.ts` (column add) | `B.1-repositories-workspaces.md` |

### Discrepancies and required spec updates

The change does **not** contradict any existing spec. It does **add behavior** that should be recorded. Verbatim text to add (the implementation must write these exact lines):

- **`specs/B.4-git-pr-ci-diff.md`** — under the "PR state" section (around line 26 `[ ] 6. PR state contributes to readiness and next action.`), insert:
  ```
  [~] 7. GitHub's `mergeable` and `mergeStateStatus` fields are surfaced through `PullRequestSummary` and gate the `ready-to-merge` readiness state.
  [~] 8. When `mergeable === "CONFLICTING"` (or `mergeStateStatus === "DIRTY"`), the workspace enters the dedicated `pr-conflicts` readiness state, distinct from the local working-tree `conflicts` state and from `checks-failing`.
  ```
  Use `[~]` (in-progress) per Citadel's spec marker convention; flip to `[x]` once the PR lands.

- **`specs/B.5-apps-links-actions.md`** — under the Hooks section, append:
  ```
  [~] 9. The optional `.citadel/hooks/fixconflicts` hook produces the prompt body for the Fix-conflicts action: when executable, its stdout (capped at 32 KB) is used; otherwise a hardcoded default (referencing the repo's non-fast-forward push policy) is used.
  ```

- **`specs/B.7-operations-activity-mcp.md`** — under the operations section, append (this is more an operation than a session affordance — picking B.7 over B.3):
  ```
  [~] 11. When a workspace's PR has failing CI and no agent session has been active for the configured idle window, Citadel may auto-launch a `fix-ci` agent. Auto-launches are deduplicated per-PR-head-SHA and debounced by a minimum-interval window; activity events emitted by such launches use `source: "automatic-rule"`.
  ```

- **`specs/A-shared-definitions.md`** — no edit needed; the existing "Readiness" definition (line 25) is broad enough to cover the new state.

## Implementation approach

**Layered, one-PR, three-commit delivery.** The slices share types and failure surface and ship together. The PR's commits:

1. `feat(providers): surface PR mergeable and mergeStateStatus through readiness` — slice 1 (detection + UI tone + readiness gate + spec updates to B.4 + CSS).
2. `feat(web): fix-conflicts action with optional hook override` — slice 2 (inspector button + hook file convention + non-FF policy extraction + spec update to B.5).
3. `feat(daemon): idle CI-failure auto-recovery tick with per-SHA + debounce dedupe` — slice 3 (dedicated tick + decide function + dedupe state + spec update to B.7).

**Why one PR, not three:** the three slices share the `mergeable` contract field (slice 1 produces it; slices 2-3 consume it), share a single failure surface (PR is unmergeable / unhealthy), and have no external blockers — the hook framework dependency (#11) is satisfied by the existing deploy-hook convention. Three sequential PRs would force a wait for #11/#12 (which we explicitly want to avoid) AND force two rebases on `workspace-card.tsx`/`readiness.ts` against parallel topic #7 instead of one.

**Key design choices (revised):**

- **`mergeable` and `mergeStateStatus` are strict zod enums with `.catch("UNKNOWN")`** — drift-tolerant without being loose. Unknown values from `gh` land in a defined "UNKNOWN" bucket that does NOT trigger `conflicting` tone or `pr-conflicts` readiness, and does NOT block `ready-to-merge` (so transient UNKNOWN during GitHub's async recompute doesn't churn the UI).
- **Fix-conflicts via `POST /api/workspaces/:workspaceId/fix-conflicts`.** Internally calls `operations.createAgentSession()` with the resolved prompt. **No 409 deduplication** — AC4 mandates "always launch new"; duplicate clicks intentionally spawn duplicates. The button optimistically disables for 1 second to prevent double-click spawn, but does NOT enforce server-side uniqueness.
- **Fix-conflicts hook = `.citadel/hooks/fixconflicts` executable**, modeled on `packages/hooks/src/deploy.ts`. Stdout cap = 32 KB (matches deploy-hook precedent). Strip ANSI escapes + trim before use.
- **Auto-recovery runs from a dedicated daemon tick — NOT from `deriveReadiness`.** Verified: `deriveReadiness` is invoked only from the cockpit summary GET handler (`apps/daemon/src/app.ts:422`); hooking auto-recovery there would only fire when an operator has the inspector open. Instead, add a new `startAutoRecoveryMonitor(deps, intervalMs = 60_000)` that mirrors the structure of `startStatusMonitor` in `packages/operations/src/status-monitor.ts:258` (interval with `.unref()`, teardown via `server.on("close")`, configurable, disable via env). Tick iterates over workspaces with a configured agent runtime, uses the existing `cachedProvider` to avoid `gh` rate-limits, and invokes the pure `decideAutoRecoveryAction` for each.
- **Per-SHA dedupe + debounce.** Two new workspace columns (both nullable, `ensureColumn`):
  - `auto_recovery_last_ci_sha TEXT` — last PR head SHA we auto-pinged for.
  - `auto_recovery_last_attempt_at TEXT` — ISO timestamp of last auto-launch.
  Fire condition (atomically updated together): `(headSha !== lastPingedSha) AND (now - lastAttemptAt > debounceMs)`. The debounce window covers same-SHA CI re-runs and the two-daemon-tick race (atomic `UPDATE … SET last_ci_sha = ?, last_attempt_at = ? WHERE id = ? AND (last_ci_sha IS NULL OR last_ci_sha != ? OR last_attempt_at < ?)` — second tick sees zero affected rows and bails).
  Default debounce: 30 minutes.

## Alternatives considered

1. **Ship as three sequential PRs (#1: detection, #2: button, #3: auto-recovery).** Rejected. Three sequential PRs would force serial review, would need two rebases on `workspace-card.tsx`/`readiness.ts` against parallel topic #7 instead of one, and would block on the perceived (but mythical) #11/#12 dependency. One PR with three clearly separated commits gives the same reviewability without those costs.

2. **Reuse an existing agent session for Fix-conflicts when one exists.** Rejected by user in the grilling round ("Always launch new"). Cleanest separation; avoids the "which session?" ambiguity in multi-session workspaces; avoids polluting an in-progress session's context window.

3. **Auto-recovery as a separate background service / scheduled agent.** Rejected: adds a new lifecycle to supervise. A daemon-internal tick mirrored on `startStatusMonitor` reuses existing supervision (lives and dies with the daemon).

4. **Auto-recovery folded into `deriveReadiness`.** Rejected (changed from initial draft after review feedback). Verified that `deriveReadiness` is only invoked from the cockpit summary GET handler — would only fire when an operator has the inspector open. Wrong path; use a dedicated tick.

5. **No per-SHA dedupe; rely on idle-window only.** Rejected: would re-ping for every CI re-run on the same commit. Per-SHA dedupe + debounce = "we already tried recently; let the human decide."

6. **`mergeable: z.string().nullable()` (loose-typed).** Rejected (changed from initial draft after review feedback). Strict enum with `.catch("UNKNOWN")` is the citadel pattern — keeps validation tight while surfacing GitHub schema drift in a controlled way.

7. **Treat PR-conflicts as part of `checks-failing`.** Rejected: `checks-failing` is about CI, fixable by code changes. PR-conflicts is about branch divergence, fixable by a merge. Different remediation prompt, different button, different readiness state. Compound case (both red CI AND conflicts) is handled by including BOTH reasons in `reasons[]` when the short-circuit fires.

## Implementation steps

### Specs (first, per repo convention)

- Update `specs/B.4-git-pr-ci-diff.md` — add the two `[~]` items shown verbatim in Spec alignment.
- Update `specs/B.5-apps-links-actions.md` — add the `[~] 9.` hook item.
- Update `specs/B.7-operations-activity-mcp.md` — add the `[~] 11.` auto-recovery item.

### Slice 1 — Detection (Commit 1)

#### Contracts
- `packages/contracts/src/index.ts` — add two strict enums above `PullRequestSummarySchema`:
  ```ts
  export const PrMergeableSchema = z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]).catch("UNKNOWN");
  export const PrMergeStateStatusSchema = z
    .enum(["CLEAN", "BEHIND", "BLOCKED", "DIRTY", "HAS_HOOKS", "UNKNOWN", "UNSTABLE", "DRAFT"])
    .catch("UNKNOWN");
  ```
- `packages/contracts/src/index.ts` `PullRequestSummarySchema` (~line 214): add
  - `mergeable: PrMergeableSchema.nullable().default(null)`
  - `mergeStateStatus: PrMergeStateStatusSchema.nullable().default(null)`
- `packages/contracts/src/index.ts` (line 407, `WorkspaceReadinessSchema.state`): add `"pr-conflicts"` to the enum (after `"conflicts"`).

#### Provider
- `packages/providers/src/index.ts` `currentPullRequest()` (~line 436): extend the `--json` arg list with `mergeable,mergeStateStatus`. Add both to the parsed type and the returned shape (typed as `string | null` at the parse boundary; the zod `.catch()` normalizes downstream).

#### Readiness
- `apps/daemon/src/readiness.ts` (line 4 input type): extend the `versionControl.pullRequest` shape with `mergeable?: string | null; mergeStateStatus?: string | null`.
- `apps/daemon/src/readiness.ts` — add a `pr-conflicts` short-circuit AFTER the existing local-`conflicts` branch (line 69) and BEFORE `checks-failing` (line 79):
  ```ts
  if (input.versionControl.pullRequest?.mergeable === "CONFLICTING") {
    return readiness("pr-conflicts", "danger", "Resolve PR conflicts against main before merging", reasons, checkedAt, degraded);
  }
  ```
- `apps/daemon/src/readiness.ts` (existing `reasons` array, ~line 47): push a reason when conflicting:
  ```ts
  pr?.mergeable === "CONFLICTING" ? "PR branch has merge conflicts with the base branch" : null,
  ```
  The existing `failingCheck`/`pendingCheck` reasons remain unchanged, so the compound case (pr-conflicts AND failing CI) surfaces both reasons.
- `apps/daemon/src/readiness.ts` (line 99 `ready-to-merge`): add `&& input.versionControl.pullRequest.mergeable !== "CONFLICTING"` to the existing condition (defensive; documents the invariant since the new short-circuit already wins).
- `apps/daemon/src/app.ts` (the `deriveReadiness` caller at line ~422): thread `mergeable` and `mergeStateStatus` from `PullRequestSummary` into the `versionControl.pullRequest` payload it constructs.

#### Web UI
- `apps/web/src/workspace-card.tsx` line 22: extend `PrTone` union to `"missing" | "pending" | "passing" | "failing" | "merged" | "conflicting"`.
- `apps/web/src/workspace-card.tsx` `prToneFor` (line 443): add the conflicting check AFTER the merged/closed short-circuits (so merged still wins) and BEFORE the failing/pending/passing branches:
  ```ts
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") return "conflicting";
  ```
- `apps/web/src/cockpit-extras.css` — add `tone-conflicting` rules. **Touch every variant** that has a sibling for `tone-failing`:
  - `.workspace-card-agent.tone-conflicting` (~line 410 block — same color as `tone-failing`, i.e. `var(--c-bad)`)
  - `.workspace-card.active .workspace-card-agent.tone-conflicting` (~line 430 block)
  - `.pr-pill.tone-conflicting` / `.approval-pill.tone-conflicting` (~line 540+ block)
- `apps/web/src/inspector-stats.css` — add:
  - `.ins-pr-badge.tone-conflicting` (~line 373, sibling of `tone-failing`)
  - `[data-theme="dark"] .ins-pr-badge.tone-conflicting` (~line 392, sibling of dark `tone-failing`)
- Mirror the structure exactly so future tone additions follow the same pattern.

### Slice 2 — Fix-conflicts button + hook (Commit 2)

#### Hook + policy constant
- `packages/hooks/src/non-ff-policy.ts` (new): export a single constant
  ```ts
  export const CITADEL_NON_FF_POLICY = `The repo policy is explicit: pull main with merge, never rebase, never force-push.`;
  ```
  This is the canonical string the fix-conflicts default prompt references. Future agents/tools should import this constant rather than re-stating the policy.
- `packages/hooks/src/fix-conflicts.ts` (new, mirrors `deploy.ts`):
  - Export `FIX_CONFLICTS_HOOK_RELATIVE_PATH = path.join(".citadel", "hooks", "fixconflicts")`.
  - Export `resolveFixConflictsPrompt({ workspacePath, workspaceId, workspaceBranch, repoId }): Promise<string>`. Behavior:
    - If hook file is executable, spawn with cwd=workspacePath + env (`CITADEL_WORKSPACE_ID`, `CITADEL_WORKSPACE_PATH`, `CITADEL_WORKSPACE_BRANCH`, `CITADEL_REPO_ID`), capture stdout (cap 32 KB matching deploy-hook precedent), strip ANSI + trim, return.
    - If exists-not-executable: emit a `hookDiagnostic`, fall back to default.
    - If missing: return default silently.
  - The hardcoded default (imports `CITADEL_NON_FF_POLICY`):
    ```
    Your branch has merge conflicts with main and the PR cannot be merged.

    Resolve them by:
    1. Run `git pull origin main` from this worktree. Use merge — NOT rebase.
       ${CITADEL_NON_FF_POLICY}
    2. Open each conflicted file and resolve the conflict markers carefully.
       Preserve both sides' intent; do not delete tests, types, or specs to make
       conflicts disappear.
    3. Run `make check` (or the minimal subset relevant to the conflict area).
    4. Commit with a focused message ("merge main into <branch>") and `git push`.

    If `git push` reports non-fast-forward after the merge, repeat from step 1.
    Never `--force` or `--force-with-lease`. When `gh pr view` reports
    mergeable=MERGEABLE again, stop and report back what was resolved.
    ```
- `packages/hooks/src/index.ts`: re-export `resolveFixConflictsPrompt`, `FIX_CONFLICTS_HOOK_RELATIVE_PATH`, `CITADEL_NON_FF_POLICY`.

#### Daemon endpoint
- `apps/daemon/src/app.ts`: add `POST /api/workspaces/:workspaceId/fix-conflicts`:
  1. Load workspace + repo (404 if not found).
  2. Pick a runtime: input runtime id from request body, or default (first configured runtime).
  3. Call `resolveFixConflictsPrompt({ workspacePath, workspaceId, workspaceBranch, repoId })`.
  4. `operations.createAgentSession({ workspaceId, runtimeId, displayName: "Fix conflicts", prompt }, runtimeConfig)`.
  5. Emit `agent.updated` + activity event `{ type: "agent.fix-conflicts.launched", source: "user", … }`.
  6. Return `{ session }` (202).
- **No 409 / dedup check.** Per AC4, every click launches a new session.

#### Activity-event provenance for system actions
- `packages/operations/src/create-agent-session.ts` (or wherever `createAgentSession` lives): add an optional `activitySource?: ActivityEvent["source"]` parameter that defaults to `"user"`. The emitted `agent.started` activity event uses this source. This is consumed by slice 3.
- Existing callers continue to pass nothing (default `"user"`) — purely additive.
- **Type-widening cascade (do this explicitly, not via `as` casts):** the existing `deps.activity` callbacks are typed with the narrow union `"user" | "system" | "hook"`, not the full `ActivityEvent["source"]` enum (which already includes `"automatic-rule"`). To accept the new value cleanly:
  - Widen the `source` parameter of the private `activity(...)` method in `packages/operations/src/index.ts` (~line 746) to `ActivityEvent["source"]`.
  - Widen the `deps.activity` `source` typing in every operations module that injects an activity callback: `create-agent-session.ts`, `deploy.ts`, `create-background-agent-session.ts`, `workspace-apps.ts`, `hooks-runner.ts`, `launch-agent.ts`. (Locate via `grep -l "source:.*\"user\"" packages/operations/src/`.)
  - Add a typescript type-assertion test: `const _check: ActivityEvent["source"] = "automatic-rule"` (acts as a compile-time canary).
- Do NOT use `as never` / `as unknown` casts to bypass the cascade — the typing is the contract; widen it properly.

#### Web UI
- `apps/web/src/inspector-stats.tsx` (or wherever the stats panel lives — locate by searching `inspector` modules for the readiness-state-driven action area): when `readiness.state === "pr-conflicts"`, render a `<button class="cit-btn-danger">Fix conflicts</button>`. onClick: `POST /api/workspaces/<id>/fix-conflicts`; disable optimistically for 1s to prevent double-click; no further server-side uniqueness check.
- If `cit-btn-danger` doesn't exist, use the closest variant from `cockpit-extras.css`.

### Slice 3 — CI auto-recovery (Commit 3)

#### Schema (DB)

Following the repo's established convention (`ensureColumn` for additive columns trailing the latest baseline — see `packages/db/src/migrate.ts:203-207`):

1. **Operations.**
   - `ensureColumn("workspaces", "auto_recovery_last_ci_sha", "TEXT")`
   - `ensureColumn("workspaces", "auto_recovery_last_attempt_at", "TEXT")`
2. **Classification.** Both additive + nullable. No `schema_migrations` row required for additive columns under the existing convention (verified at migrate.ts:203-207 — trailing additive `ensureColumn` calls do not get their own version row).
3. **`PRAGMA foreign_keys = ON;` preservation.** No FK touched.
4. **Operator data implications.** New columns start NULL; first CI-red+idle event fires normally. No backfill needed.

#### Daemon
- `apps/daemon/src/auto-recovery.ts` (new): export
  ```ts
  export function decideAutoRecoveryAction(input: {
    workspace: { id: string; auto_recovery_last_ci_sha: string | null; auto_recovery_last_attempt_at: string | null };
    sessions: Array<{ status: string; runtimeId?: string; lastOutputAt?: string | null; lastStatusAt?: string | null }>;
    pr: { headSha: string | null; mergeable: string | null; checks: Array<{ status: string; conclusion: string | null }> } | null;
    runtime: { id: string; command: string; args: string[]; displayName: string; promptArg?: string | null } | null;
    now: Date;
    idleThresholdMs: number;
    debounceMs: number;
    disabled: boolean;
  }): { fire: boolean; reason: string; sha: string | null };
  ```
  Pure decision function. Fires only when:
  - `disabled === false`,
  - `runtime !== null`,
  - `pr !== null && pr.headSha !== null`,
  - At least one of `pr.checks` is in `["failure","cancelled","timed_out","action_required"]`,
  - No session is currently `["starting","running"]` AND the latest activity timestamp (max of `lastOutputAt`/`lastStatusAt` across sessions) is older than `idleThresholdMs`,
  - `(pr.headSha !== workspace.auto_recovery_last_ci_sha) OR (now - auto_recovery_last_attempt_at > debounceMs)` — debounce covers same-SHA CI re-runs.
- `packages/operations/src/auto-recovery-monitor.ts` (new): export `startAutoRecoveryMonitor(deps, intervalMs = 60_000)` mirroring the structure of `startStatusMonitor` in `packages/operations/src/status-monitor.ts:258`:
  - `setInterval(...)` with `.unref()`.
  - Returns `{ stop }`.
  - Each tick:
    1. List workspaces with a configured agent runtime.
    2. For each, fetch PR + CI from the cached provider (`cachedProvider` per `apps/daemon/src/app.ts`) — no fresh `gh` calls in the hot loop.
    3. Call `decideAutoRecoveryAction`.
    4. If `fire === true`:
       - Run atomic `UPDATE workspaces SET auto_recovery_last_ci_sha = ?, auto_recovery_last_attempt_at = ? WHERE id = ? AND (auto_recovery_last_ci_sha IS NULL OR auto_recovery_last_ci_sha != ? OR auto_recovery_last_attempt_at < ?)`. If 0 rows affected (another tick won the race), skip.
       - Otherwise call `operations.createAgentSession({ workspaceId, runtimeId, displayName: "Fix CI", prompt: FIX_CI_PROMPT }, runtimeConfig, { activitySource: "automatic-rule" })`.
- Wire `startAutoRecoveryMonitor` into the daemon startup alongside `startStatusMonitor`. Wire teardown via the existing server-close handler.

Idle threshold + debounce + global enable (all env-configurable, with TODO for `packages/config` follow-up):
- `CITADEL_AUTO_RECOVERY_DISABLED=1` — disable entirely.
- `CITADEL_AUTO_RECOVERY_IDLE_MS` — default `300000` (5 min).
- `CITADEL_AUTO_RECOVERY_DEBOUNCE_MS` — default `1800000` (30 min).
- `CITADEL_AUTO_RECOVERY_INTERVAL_MS` — default `60000` (1 min tick).
- Document a TODO: surface these in `packages/config` as a follow-up so per-repo policy is possible.

Fix-CI prompt (constant, no hook override for now — out of scope):
```
The PR for this workspace has failing CI checks and no agent has been working
on this workspace recently. You were auto-launched by Citadel to investigate.

Investigate and fix:
1. Run `gh pr checks` to identify failing jobs.
2. For each failing job, run `gh run view <id> --log-failed` (or `--log`) to
   read the actual error.
3. Reproduce locally with the same command CI runs.
4. Fix the underlying cause. Do NOT delete or skip tests, types, or assertions
   to make CI pass — fix the root cause.
5. Run `make check` (or the minimal targeted subset).
6. Commit with a focused message and `git push`. ${CITADEL_NON_FF_POLICY}

If you genuinely cannot fix the failure, stop and explain why in the activity
log. Do NOT loop indefinitely.
```

### Wire-up

- After all three slices are implemented and pass `make check`, run `make e2e`. If readiness UI changes break a snapshot, regenerate it.
- Run `make smoke` (new HTTP route requires it).
- Manual smoke: open a PR with conflicting changes locally (use a sandbox repo), point Citadel at it, confirm the inspector shows `pr-conflicts` + "Fix conflicts" button. Then mark CI red and wait for the auto-recovery tick interval — confirm activity log shows an `automatic-rule` agent launch.

### Integration with topic #7 (PR display)

Topic #7 also touches `apps/web/src/workspace-card.tsx` and `apps/daemon/src/readiness.ts`. Coordination plan:

- This PR's changes to `PrTone` are purely additive (`| "conflicting"`), so a parallel `PrTone` extension in topic #7 should be a trivial union merge.
- This PR's changes to `readiness.ts` add ONE new short-circuit branch + ONE new reason. If topic #7 also touches `deriveReadiness`, both PRs touch sibling branches in the same `if`-chain; merge conflict resolution is mechanical.
- **Order:** whichever topic merges first gets clean state; the second rebases against main. Per memory `feedback_non_ff_pushes.md`: pull main with **merge, not rebase**. So the second PR will produce a merge commit, not a rebased history — that's intentional per repo policy and pre-public direct-push convention.

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | **Required** | Pure functions in `prToneFor`, `deriveReadiness`, `resolveFixConflictsPrompt`, `decideAutoRecoveryAction`. Plus a daemon-level integration-style Vitest using the in-memory store to cover the tick wiring → side-effect path. |
| E2E (Playwright) | **Required** | The user-visible PR-tone + Fix-conflicts button affordance is exactly the kind B.8 #6 mandates E2E for. |

### New tests to add

**Unit (Vitest) — Slice 1 (Detection):**

- `packages/providers/src/index.test.ts` — *new test* `currentPullRequest threads mergeable and mergeStateStatus from gh pr view`. Mocks `gh` (existing fixture pattern), asserts the returned object includes `mergeable: "CONFLICTING"` and `mergeStateStatus: "DIRTY"`.
- `packages/contracts/src/index.test.ts` (or closest existing schema test file — locate via `grep -l PullRequestSummarySchema packages/contracts/src/`) — *new tests*:
  - `PullRequestSummarySchema accepts mergeable and mergeStateStatus, defaults to null`.
  - `PrMergeableSchema.catch("UNKNOWN") maps unknown values to UNKNOWN` (e.g. parses `"WEIRD_NEW_VALUE"` → `"UNKNOWN"`).
  - `PrMergeStateStatusSchema.catch("UNKNOWN")` — same.
- `apps/daemon/src/readiness.test.ts` (exists? if not, create) — *new tests*:
  - `pr-conflicts state fires when mergeable=CONFLICTING and trumps checks-failing`.
  - `pr-conflicts compound case includes the failing-check reason in reasons[] when CI is also red`.
  - `pr-conflicts state does NOT fire when local working-tree conflicts already gated it (local conflicts wins)`.
  - `blocked state still wins over pr-conflicts`.
  - `ready-to-merge does not fire when mergeable=CONFLICTING even if reviewDecision=APPROVED and checks pass`.
  - `ready-to-merge still fires when mergeable=MERGEABLE`.
  - `ready-to-merge still fires when mergeable=UNKNOWN` (transient — does NOT block).
  - `pr-conflicts does NOT fire when mergeable=UNKNOWN` (transient — does NOT block).
- `apps/web/src/workspace-card.test.tsx` (verify existence; create if missing) — *new tests*:
  - `prToneFor returns "conflicting" when mergeable === "CONFLICTING"`.
  - `prToneFor returns "conflicting" when mergeStateStatus === "DIRTY"` (even if `mergeable` is null/UNKNOWN).
  - `prToneFor returns "merged" for merged PR even if mergeable is CONFLICTING` (merged precedence).
  - `prToneFor does NOT return "conflicting" when mergeable === "UNKNOWN"`.
  - `prToneFor does NOT return "conflicting" when mergeable === null`.
  - `prToneFor "conflicting" wins over "failing"` (i.e., PR with failing checks AND conflicts → conflicting).

**Unit — Slice 2 (Fix-conflicts):**

- `packages/hooks/src/fix-conflicts.test.ts` (new) — *new tests*:
  - `resolveFixConflictsPrompt returns the hardcoded default when no hook file exists`.
  - `resolveFixConflictsPrompt returns hook stdout when the hook is executable`.
  - `resolveFixConflictsPrompt falls back to default and emits a diagnostic when the hook exists but is not executable`.
  - `resolveFixConflictsPrompt caps stdout at 32 KB`.
  - `resolveFixConflictsPrompt strips ANSI escapes and trims trailing whitespace`.
  - `default prompt contains the CITADEL_NON_FF_POLICY constant` — guards against silent policy drift.
- `apps/daemon/src/app.test.ts` (or app-routes test file) — *new tests*:
  - `POST /api/workspaces/:id/fix-conflicts launches a session with the resolved prompt and emits an activity event with source="user"`.
  - `POST /api/workspaces/:id/fix-conflicts allows duplicate launches by design (no 409)` — explicit assertion that two back-to-back POSTs both 202.

**Unit — Slice 3 (Auto-recovery):**

- `apps/daemon/src/auto-recovery.test.ts` (new) — pure decide-function tests:
  - `decideAutoRecoveryAction fires when CI red AND no active sessions AND idle ≥ threshold AND headSha differs from lastPingedSha`.
  - `decideAutoRecoveryAction fires when CI red AND debounce window expired even if headSha === lastPingedSha` — covers same-SHA CI re-run.
  - `decideAutoRecoveryAction skips when an agent session is running`.
  - `decideAutoRecoveryAction skips when idle window < threshold`.
  - `decideAutoRecoveryAction skips when lastPingedSha === headSha AND last_attempt_at within debounce window`.
  - `decideAutoRecoveryAction skips when no runtime configured`.
  - `decideAutoRecoveryAction skips when disabled === true`.
  - `decideAutoRecoveryAction skips when PR is null or headSha is null`.
  - `decideAutoRecoveryAction returns headSha to persist when firing`.
- `apps/daemon/src/auto-recovery-monitor.test.ts` (new) — **daemon-level integration test** using the in-memory SQLite store + a stubbed `createAgentSession`:
  - Seed workspace with: red CI, idle sessions, no prior SHA, runtime configured.
  - Run one tick.
  - Assert `createAgentSession` was called once with `displayName: "Fix CI"`, the fix-CI prompt, and `activitySource: "automatic-rule"`.
  - Assert `auto_recovery_last_ci_sha` and `auto_recovery_last_attempt_at` were persisted.
  - Run a second tick (same SHA, within debounce).
  - Assert `createAgentSession` was NOT called again.
  - Assert the atomic UPDATE behaved correctly (mock a "concurrent tick" by manually bumping `last_attempt_at` mid-test and confirming the UPDATE WHERE clause filters it out).

**E2E (Playwright):**

- `e2e/pr-conflicts.spec.ts` (new) — seed a workspace with a mocked PR summary where `mergeable: "CONFLICTING"`. Assert:
  - Workspace card shows the `tone-conflicting` class.
  - Inspector readiness label reads "Resolve PR conflicts against main before merging".
  - "Fix conflicts" button is rendered.
  - (Do NOT exercise the click → real agent launch in E2E — covered by the daemon route test.)

### Existing tests to update

The schema additions use `.default(null)` so most existing fixtures don't need updates. But:

- `apps/daemon/src/readiness.test.ts` — existing tests calling `deriveReadiness` with a `pullRequest` object: no change strictly required (the new fields default to undefined → "no conflicting" path), but tests that assert `ready-to-merge` should explicitly pass `mergeable: "MERGEABLE"` to document the contract.
- `apps/web/src/workspace-card.test.tsx` — same: no fixture sweep required because of `.default(null)`. Only the new tests above need new fixtures.
- Other test files: only update if a test is going to flip on the new state (none expected outside the files listed above).

### Assertions to add/change/tighten

- **Tighten** the `ready-to-merge` test to also assert that the same scenario with `mergeable: "CONFLICTING"` returns `pr-conflicts` (regression guard for the gate).
- **Add** assertion: `prToneFor`'s `conflicting` wins over `failing`.
- **Add** assertion: auto-recovery emits `source: "automatic-rule"` (provenance regression guard).
- **Add** assertion: auto-recovery's atomic UPDATE returns 0 rows when another tick has already updated, and `createAgentSession` is NOT called.

### Failure modes / edge cases / regression risks

- **`gh` returning `mergeable: "UNKNOWN"`** (GitHub computing async, fresh push) — does NOT trigger `conflicting`. The transient 1-3s window where the PR may briefly show `passing` before flipping to `conflicting` is acceptable and documented (a future polish item could add a "pending-merge-compute" tone).
- **`gh` returning a `mergeable` value we haven't seen** (e.g., GitHub adds a new state) — `.catch("UNKNOWN")` normalizes it.
- **Workspace with multiple agent sessions** — auto-recovery uses the `activeAgentSession` predicate (readiness.ts line 39) AND the max-activity-timestamp idle check.
- **Race: PR conflicts resolve between deciding to fire and firing.** Acceptable — the agent will check, see no conflicts, and exit.
- **Race: two daemon ticks both see "fire" simultaneously.** Mitigated by the atomic UPDATE … WHERE last_attempt_at < ? — second tick affects 0 rows and bails.
- **Same-SHA CI re-run flips back to red.** Mitigated by the debounce window (default 30 min).
- **Daemon restart between firing and persistence.** Atomic UPDATE happens BEFORE createAgentSession; worst case is a recorded ping with no session — next tick treats it as "we tried", debounce holds.
- **Hook stdout has ANSI escapes or trailing newlines.** Strip + trim. Cap at 32 KB.
- **Workspace has no PR (yet).** `pr-conflicts` only fires inside `pullRequest?` checks; auto-recovery decide returns `fire: false` when `pr === null`.
- **PR is closed/merged.** `prToneFor` `merged` branch wins; `deriveReadiness` ready-to-merge gate intentionally never fires for closed.
- **Operator manually started an agent right before tick.** The idle threshold + activity-timestamp check sees recent activity and skips.

### Adversarial analysis

- **How could this fail in production?**
  - `gh` CLI version drift — older versions might not return `mergeable`. `.nullable().default(null)` handles via fallback.
  - GitHub returning a new `mergeStateStatus` value — `.catch("UNKNOWN")` normalizes.
  - Auto-recovery thrashing — debounce + per-SHA dedupe + atomic UPDATE collectively prevent it.
  - `gh` rate-limit blowout — the auto-recovery tick reads from `cachedProvider`, not fresh `gh` calls. Fresh fetches still respect the existing provider-refresh cadence.
- **What user actions trigger unexpected behavior?**
  - User manually marks a PR as draft → still has `mergeable`. `prToneFor` doesn't change draft handling.
  - User clicks "Fix conflicts" repeatedly. Each click launches a new session (AC4 — by design). UI disables button optimistically for 1s only.
- **What existing behavior could break?**
  - Topic #7 (PR display) also touches `workspace-card.tsx` and may add `PrTone` cases. Mitigation: this PR's union extension is additive. See "Integration with topic #7" subsection.
  - Readiness state enum is consumed by cockpit and command-palette UIs (`apps/web/src/command-palette.tsx`). Adding `"pr-conflicts"` is additive. Audit `apps/web/**` for switch/case over readiness state during implementation.
- **Which tests credibly catch those failures?**
  - `prToneFor` precedence tests + UNKNOWN/null tests catch tone regressions.
  - `deriveReadiness` "local conflicts wins" + "blocked wins" tests catch precedence regressions.
  - `decideAutoRecoveryAction` dedupe + debounce tests catch policy regressions.
  - `auto-recovery-monitor.test.ts` integration test catches tick-wiring regressions (the failure mode the reviewer surfaced).
  - The schema-catch tests catch GitHub-side drift.
  - The E2E `pr-conflicts.spec.ts` catches visual regressions on the inspector affordance.
- **What gaps remain?**
  - No live `gh` integration test — relies on GitHub maintaining backward compatibility. Mitigation: `.catch("UNKNOWN")` makes drift visible (UNKNOWN values, surface them in logs).
  - No live `claude-code` runtime test — prompts are plain text; runtime accepts any string.

### Scope calibration

- BE unit: required.
- FE unit: required (`prToneFor`, button component).
- Integration: covered by `auto-recovery-monitor.test.ts` (in-memory store + stubbed createAgentSession) — this is the daemon-level integration layer per Citadel's two-layer convention.
- E2E: required for the cockpit affordance per B.8.

## Tests

TDD order — tests first per layer, then implement:

1. **Slice 1 tests (write first):**
   - `packages/contracts/src/index.test.ts` (or schema test file) — schema additions + `.catch()` normalization.
   - `packages/providers/src/index.test.ts` — `gh pr view` JSON parse.
   - `apps/daemon/src/readiness.test.ts` — `pr-conflicts` branch + `ready-to-merge` gate + UNKNOWN handling + compound case.
   - `apps/web/src/workspace-card.test.tsx` — `prToneFor` precedence + UNKNOWN.
2. **Slice 2 tests:**
   - `packages/hooks/src/fix-conflicts.test.ts` — hook resolution + ANSI strip + 32 KB cap + policy constant.
   - `apps/daemon/src/app.test.ts` (or app-routes test file) — `POST /api/workspaces/:id/fix-conflicts` happy path + duplicate-allowed assertion.
3. **Slice 3 tests:**
   - `apps/daemon/src/auto-recovery.test.ts` — pure decide function.
   - `apps/daemon/src/auto-recovery-monitor.test.ts` — daemon-level integration (tick → createAgentSession + persisted SHA + second tick no-op + atomic UPDATE race).
4. **E2E:**
   - `e2e/pr-conflicts.spec.ts` — cockpit affordance.

## Schema or contract generation

- `@citadel/contracts` exports `PullRequestSummary` and `WorkspaceReadiness` types directly from zod schemas — no separate generation step. `pnpm build` regenerates `.d.ts`.
- SQLite schema: `packages/db/src/migrate.ts` adds two `ensureColumn(...)` calls following the existing trailing-additive-column convention. No new `schema_migrations` row.
- No OpenAPI or codegen step.

## Verification

Before opening the PR, the following must pass:

- `make check` — `check:arch`, `check:size`, `typecheck`, `lint`, `test`, `coverage`, `check:deps`, `build`. **Required**.
- `make e2e` — Playwright. **Required** (new `pr-conflicts.spec.ts`).
- `make smoke` — local API smoke against running daemon. **Required** because of the new HTTP route (`POST /api/workspaces/:id/fix-conflicts`).
- `make performance` — **Not required**. The new auto-recovery tick runs once per minute, reads cached state — not a hot path. Readiness recompute path unchanged in cadence.

If `make check` reports a coverage drop, fix at the test layer, not by lowering the coverage gate (`docs/contributors/v2-engineering-standards.md` mandates 90% on core/backend/shared).
