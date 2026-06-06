Activate the /implement-task skill first.

# Plan: Workspace nav & lifecycle

Scratchpad block id: `00000005-0005-4005-8005-000000000005`
Branch: `agent/05-workspace-nav-0mos2w`
Plan saved at: `.agents/plans/workspace-nav-lifecycle.md`

## Acceptance Criteria

Verbatim from scratchpad block 5 (after splitting out Superworkspace and Inbox view, which were moved to their own blocks):

- [ ] AC1. Focus the last remaining agent after closing one
- [ ] AC2. Manual drag-and-drop reordering of workspaces in the nav (client-only, persisted in localStorage)
- [ ] AC3. Creation modal closes instantly; the new workspace shows a setup-progress UI inline while it initializes; user can switch away while it boots (inspiration: superset.sh) — driven by per-stage daemon events
- [ ] AC4. Optimistic removal from nav on drop, even if teardown is still running in the background — only re-appears if backend cleanup fails (or page reloads)
- [ ] AC5. Drop-blocked dialog ("uncommitted changes / unpushed commits") must show the actual summary of those changes/commits
- [ ] AC6. Selecting a workspace must focus its terminal
- [ ] AC7. New workspaces auto-get funny names (e.g. `funny-cat`) when none is provided
- [ ] AC8. "Group by workspace" modal doesn't close when clicking outside — fix to close on backdrop click
- [ ] AC9. Collapse-inspector button should mirror the workspace collapse button (not an `x`)

## Context and problem statement

The workspace navigator (`apps/web/src/navigator.tsx`), workspace card (`apps/web/src/workspace-card.tsx`), create-workspace modal (`apps/web/src/modals.tsx`), and stage / inspector chrome have accumulated nine independent UX defects that all live in the same file neighborhood. They are coherent to ship together because:

- All nine fit within the workspace-lifecycle product story (B.1, B.2).
- Most are UI-local; the daemon needs only two surgical additions: structured per-stage create events on the SSE stream, and a "dirty summary" payload on the delete response.
- The most invasive bits (optimistic remove + async create) interact with the same React Query mutation cycle, so doing them in one PR avoids two rounds of mutation/handler churn.

Concretely, today:
- Closing the active agent tab in `Stage` (`apps/web/src/stage.tsx:122`–`:236`) leaves the cockpit blank for up to 4s while the `keepPending` grace timer ticks (`stage.tsx:37`–`:51`); the user wants immediate refocus to a remaining tab.
- The nav has no manual ordering — workspace rows are ordered by `buildGroupTree` (`apps/web/src/navigator-groups.ts`) and the user can't influence the sequence.
- `CreateWorkspaceModal` awaits the full `POST /api/workspaces` round-trip (`modals.tsx:362`–`:397`), which currently runs clone + setup hooks inline (`packages/operations/src/index.ts:148`–`:276`). The modal stays open for the entire bootstrap; the user can't switch away.
- `DropWorkspaceDialog` (`workspace-card.tsx:373`–`:433`) waits for the DELETE response before re-rendering, blocking the nav. The dirty-block path only displays the generic string "Workspace has uncommitted changes or unpushed commits" — no file list, no commit subjects.
- `WorkspaceCard.onSelect` (`workspace-card.tsx:114`) just calls `props.onPickWorkspace(workspace)`. It does not focus the xterm of the active session; the user has to click into the terminal manually.
- `CreateWorkspaceModal` falls back to `defaultNamePreview(linked)` returning `"workspace"` when no Jira key is provided (`modals.tsx:325`–`:328`). Multiple un-named workspaces collide on the unique-name constraint (see `WorkspaceNameTakenError` in `packages/operations/src/index.ts:198`).
- `GroupByMenu` (`modals.tsx:26`–`:66`) has document-mousedown handling but the user reports it doesn't close on outside clicks. Worth a real repro and a hardened fix.
- The inspector collapse button uses an `X` icon (`inspector.tsx:64`), inconsistent with the navigator's `PanelLeftClose` chevron (`navigator.tsx:211`). Spec B.2 #4 says the inspector collapse control lives in the top-left of the inspector, but doesn't constrain the glyph; the user wants visual symmetry.

## Spec alignment

Specs touched (per `.agents/skills/extensions/review-pr.md` mappings):
- `specs/B.1-repositories-workspaces.md` — workspace lifecycle, create + remove flows, navigator grouping, workspace names.
- `specs/B.2-ade-cockpit.md` — collapse controls, modal backdrop dismissal, terminal focus.

Required spec updates (treated as the FIRST implementation step per skill rules):

1. `B.1 §Workspaces / Navigator`: add a clause specifying that workspace rows are manually reorderable within their group via drag-and-drop, with order persisted locally (no server sync today). Cite ordering precedence: explicit user order overrides the default sort.
2. `B.1 §Create workspace`: add a clause specifying that the create modal closes immediately on submit; the resulting workspace appears in the navigator with an inline setup-progress affordance (stage labels: fetching · adding worktree · running setup hooks · ready); the user can switch away while it boots; failures surface inline.
3. `B.1 §Workspaces / Identity`: add a clause specifying that when no name is provided at creation, Citadel generates a memorable two-token name (adjective + animal). Names must be unique within the active workspace set.
4. `B.1 §Remove workspace`: add clauses specifying (a) the navigator removes the workspace optimistically on drop confirmation and only re-renders the row if teardown fails; (b) when removal is blocked by dirty state, the dialog must surface the actual summary (file list + unpushed commit subjects).
5. `B.2 §Cockpit shell`: clarify that the inspector collapse control uses the same chevron-style affordance as the navigator collapse (visual symmetry — this aligns with the existing spec line "left collapse control sits on the same row as the Dashboard link" / "right collapse control lives in the top-left corner of the inspector", but pins the glyph).
6. `B.2 §Cockpit shell` (existing line #14): no change needed — it already says "backdrop dismissal and Esc close them"; the GroupByMenu popover bug is a violation of the existing spec, not a spec gap.
7. `B.2 §Agent stage` (or new clause): add: selecting a workspace focuses its currently-active session terminal. Closing the active agent session immediately focuses the remaining session in the workspace (no grace blank).

All changes are additive; no spec rewrites.

## Implementation approach

Strategy: one feature branch, ordered into self-contained commits so the PR reads as nine small changes plus one daemon contract addition. Use TDD: Vitest unit tests precede each unit; an E2E Playwright happy-path covers the full create/drop optimistic loop.

Order optimised for blast radius:
1. Spec updates first (no code dependency).
2. Pure-UI fixes with no daemon coupling: AC1 (focus next), AC6 (focus terminal on select), AC8 (group-by close), AC9 (inspector collapse chevron). These are safe to land independently and de-risk the rest.
3. Funny-name generator (AC7) — pure helper + a small daemon hook + a small UI call site.
4. Drag-reorder (AC2) — adds a localStorage-backed sort layer in the navigator.
5. Drop-dirty summary (AC5) — daemon surface + UI: extend `workspaceIsDirty` to `workspaceDirtySummary`, surface in DELETE response, render in dialog.
6. Optimistic removal (AC4) — depends on the dirty summary being in place so the dialog can decide whether to dismiss optimistically (only when the request returns `removed: true` OR the user has acknowledged a force).
7. Async create + setup-progress (AC3) — the biggest change; daemon makes `createWorkspace` return immediately after DB insert, then runs the rest as a background task emitting `workspace.setup.stage` events; UI consumes them.

Two reusable invariants drive the design:
- The `Workspace.lifecycle` enum already has `creating | ready | failed` (`packages/contracts/src/index.ts` — confirm; existing code uses these literals at `packages/operations/src/index.ts:180,240,259`). The setup-progress UI keys off `lifecycle === "creating"`, with the per-stage label sourced from the latest SSE event.
- The SSE `emit()` already exists (`apps/daemon/src/app.ts:55`); we add one new event type `workspace.setup.stage` rather than changing existing payloads.

## Alternatives considered

- **Split into two PRs (UX wins + lifecycle)** — rejected. The optimistic remove and async create share the React Query mutation lifecycle and the workspace card's render path; splitting forces a second round of conflict resolution against this same area. The user explicitly chose a single PR after weighing it.
- **Server-side per-user workspace ordering** — rejected for now (user chose client-only localStorage). Avoids a schema change. A follow-up can promote `sortOrder` to the `workspaces` table if/when sync across devices matters.
- **Persist optimistic-removed IDs in localStorage so reload doesn't resurrect the row briefly** — rejected. The scratchpad explicitly says "re-appears if backend cleanup fails (or page reloads)" — so reload-resurrection is acceptance behavior, not a bug. A reload reflects authoritative state; localStorage layering would just risk drift.
- **Add `workspace.setup.progress` numeric events instead of named stages** — rejected. Stage names are more useful to the user ("running setup hooks" vs "75%") and the existing `Operation.progress` already tracks numeric progress; the UI can read it from `state.operations` if needed. Stages are the additive surface.
- **Funny-name generator on the client** — rejected. Daemon-side uniqueness check is authoritative (the DB has a unique constraint on workspace name within a repo, see `WorkspaceNameTakenError`). Generating client-side and retrying on conflict is fine, but doing it on the daemon avoids the retry round-trip when the modal closes instantly.

## Implementation steps

### Step 0 — Spec updates (FIRST)
- `specs/B.1-repositories-workspaces.md`: add the workspace-lifecycle clauses described above (drag-reorder within group only — cross-group drops not supported in this PR; async create with setup-progress; auto-generated names with no UI distinction from user-chosen names — renameable via the existing rename flow; optimistic remove; dirty summary surfaces in the drop dialog).
- `specs/B.2-ade-cockpit.md`: add the cockpit clauses:
  - collapse chevron symmetry between navigator and inspector;
  - selecting a workspace focuses its currently-active session's terminal IFRAME (xterm keyboard capture still requires one click inside the terminal pane — cross-origin frame limitation, see Step 2 / AC6);
  - closing the active agent session immediately focuses the LEFT-sibling tab (no `keepPending` grace blank);
  - the Stage's "+" add-session button is disabled while `workspace.lifecycle === "creating"`.

### Step 1 — Funny-name generator (AC7)
- Add `packages/core/src/funny-name.ts` exporting `generateFunnyName(rng: () => number = Math.random): string`. Two small dictionaries (~30 adjectives, ~30 animals). Join with `-`. Pure function, no side effects, no forbidden imports — passes the architecture-boundary gate.
- Add `packages/core/src/funny-name.test.ts` covering: deterministic output for an injected `rng` returning a fixed value, dictionary coverage across N=100 calls, shape (`/^[a-z]+-[a-z]+$/`).
- In the new `packages/operations/src/create-workspace.ts` (see Step 6.0), when `input.name` is falsy AND `input.source !== "issue"`, generate a funny name and retry up to 5 times on `isUniqueWorkspaceNameViolation`. After 5 attempts, append a 4-char random suffix and try once more; final failure surfaces as today.
- In `apps/web/src/modals.tsx:325` (`defaultNamePreview`), when the linked context is `scratch` and no name is typed, change the placeholder hint from `"workspace"` to `e.g. funny-cat` to telegraph the behavior. Don't generate on the client — let the daemon pick.

### Step 2 — Pure UI fixes
- **AC1 / focus the last remaining agent**: in `apps/web/src/stage.tsx`, change the close-tab `onClick` (currently L233 `stopSession.mutate(tab.session.id)`) to first compute a `nextActiveSessionId` from the tab list (sibling tab — prefer the one to the LEFT if any, else to the right), call `props.onActiveSession(nextActiveSessionId)` synchronously, then mutate. This makes `pendingActive` never go true on close. If the closed tab is the only one, do nothing (no other tab to pick).
- **AC6 / focus terminal on select**: the ttyd iframe is cross-origin (different port), so `iframe.contentWindow.focus()` cannot deliver keyboard focus into xterm — it can only focus the iframe element itself. The realistic UX win is: clicking a workspace row focuses the iframe (single Tab away from typing) and removes ambiguity about which terminal is "live". Implementation: in `apps/web/src/workspace-card.tsx:114` (`onClick`), after `props.onPickWorkspace(workspace)`, schedule a microtask that calls `focusActiveTerminal()` exported from `apps/web/src/terminal-pane.tsx`. The helper looks up `getTerminalHandle(activeSessionId)` and calls `handle.focusIframe()`, which invokes `iframeRef.current?.focus({ preventScroll: true })` on the `<iframe>` element (NOT `contentWindow`). Add `tabindex="-1"` on the iframe so it can receive programmatic focus. Skip the call when `document.activeElement` is a text input/contenteditable. **No-op case (addresses C-NEW-4)**: if the workspace has no active session (`activeSessionId` is null/undefined, or `getTerminalHandle` returns undefined — e.g. freshly-created `lifecycle="creating"` workspace, or `ready` workspace with no agent started), `focusActiveTerminal()` returns silently without throwing. Spec clause: "if the workspace has no active session, focusing the workspace is a no-op (no error)". AC6 is met to the extent the iframe IS focused when one exists; xterm keyboard capture still requires one click into the terminal area, which is documented in the spec clause (Step 0) — explicit limitation, not a silent failure. Unit tests: (a) `iframe.focus` is called (not `contentWindow.focus`); (b) `focusIframe` is a no-op when an input is currently focused; (c) `onPickWorkspace` on a session-less workspace does not throw and does not focus any iframe.
- **AC8 / group-by close on outside click**: `GroupByMenu` survey confirmed a single call site (`apps/web/src/navigator.tsx:240`–`:250` only). Issue: the trigger button lives outside the menu's `ref.current`, so a mousedown on the button fires `onClose()` AND then toggles `showGroupBy` back on — appears "not closing". Fix: rename the existing wrapper `<div className="cit-gb">` to also receive a `ref`, and pass that ref to `GroupByMenu` as an optional `containerRef` prop; the menu's contains-check uses `containerRef` when provided (falling back to its inner ref). The wrapper now contains BOTH the button and the menu, so a click on the button is "inside" and won't close the menu — the button's own onClick toggles it normally.
- **AC9 / inspector collapse chevron**: in `apps/web/src/inspector.tsx:64`, replace `<X size={12} />` with `<PanelRightClose size={14} />` (import from `lucide-react`). Mirrors `PanelLeftClose` used at `navigator.tsx:211`.

### Step 3 — Drag-reorder (AC2)
- Storage key: `citadel.navigator-order` → JSON `Record<string, string[]>` keyed by group path (`"repo/<repoId>"`, `"status/<status>"`, etc.) or the literal `"__flat"` when grouping is `"none"`. Values are workspace-id arrays. Workspaces not present in the array sort after, in their default order.
- In `apps/web/src/navigator.tsx`, read the order once at mount via a `useState` initializer, persist via `useEffect`. Garbage-collect stale ids on mount by intersecting with live workspace ids (same pattern as the collapsed-pruning effect at `navigator.tsx:121`–`:135`).
- Add a sort step in `renderWorkspace` callsites: when rendering each group's `workspaces[]`, run `applyLocalOrder(entries, order[groupPath])`. Implement helper `apps/web/src/navigator-order.ts` with `applyLocalOrder<T extends { workspace: { id: string } }>(entries: T[], idOrder: string[] | undefined): T[]`.
- Drag affordance: extend `WorkspaceCard` to be `draggable` always (rename the namespace-mode `draggable` prop to `dropTarget: "namespace"`; introduce a new dataTransfer mime type `application/x-citadel-workspace-reorder` carrying `workspaceId` AND `groupPath`).
- Drop targets: each rendered workspace row becomes a drop target. **Early-exit `onDragOver`** when the reorder mime type's `groupPath` (read via `event.dataTransfer.types` — must be encoded into the mime type itself since `getData` is unavailable in `dragover`) does not match the target row's group path. No indicator renders for cross-group drops. Implementation note: dataTransfer.getData is restricted to `drop`; encode the source group path into the mime type suffix (e.g. `application/x-citadel-workspace-reorder+repo/<repoId>`) so we can read it from `event.dataTransfer.types` during `dragover`. On `drop`, splice the dragged id into the local order array at the target index in the SAME group.
- Namespace-mode drag (for namespace reassignment) keeps the existing `application/x-citadel-workspace-id` mime type — separate code path, no interaction with reorder.
- Drop indicator: CSS class `is-drop-above` / `is-drop-below` based on `event.clientY` relative to the row midpoint.
- Trade-off: native HTML5 drag API instead of `react-dnd`/`@dnd-kit` to avoid a ~30KB dependency (Lockfile-sensitivity gate).

### Step 4 — Drop-blocked dirty summary (AC5)
- `packages/operations/src/helpers.ts`: extend with `workspaceDirtySummary(workspacePath: string): { files: Array<{ status: string; path: string }>; unpushedCommits: Array<{ sha: string; subject: string }>; }`. Reuse `git status --porcelain=v1` (parse two-char status code + path), and `git log --pretty=%H%x00%s @{u}..HEAD` for unpushed commits (mirror the fallback path in `workspaceHasUnpushedCommits` when `@{u}` doesn't resolve, using `git log --pretty=%H%x00%s HEAD --not --remotes`). Cap at 50 files and 20 commits.
- `packages/contracts/src/index.ts`: extend the workspace-remove result schema (locate during implementation) with optional `dirtySummary: { files: Array<...>; unpushedCommits: Array<...>; }`, present when `removed === false && dirty === true`.
- In `packages/operations/src/remove-workspace.ts` (extracted per Step 6.0): when the dirty branch fires (`packages/operations/src/index.ts:423` today, will be in the new module post-extraction), attach the summary to the return value.
- `apps/web/src/workspace-card.tsx:373` (`DropWorkspaceDialog`): when `dirtyBlocked` is true and `result.dirtySummary` is present, render structured lists: "Uncommitted changes (N)" with file paths + porcelain status code, and "Unpushed commits (N)" with short sha + subject. Defensive fallback to the generic message if both arrays are empty.
- CSS: add a `drop-workspace-summary` block in `apps/web/src/modals.css` (confirm exact stylesheet during implementation).

### Step 5 — Optimistic removal (AC4)
- `apps/web/src/workspace-card.tsx:374` (`DropWorkspaceDialog.drop` mutation): switch to React Query's `onMutate` doing an optimistic cache update on the `["state"]` query — remove the workspace from `workspaces[]` immediately and stash the previous state in the mutation context. On `onSuccess`: if `result.removed`, leave the optimistic state in place; if `result.removed === false`, restore via `queryClient.setQueryData(["state"], context.previous)`. On `onError`: same rollback.
- **Mutation-lifecycle blacklist (replaces 5s TTL)**: the cockpit's cache repopulates via `useStateQuery`'s 5s refetch and post-`invalidateQueries` refetch — there is NO payload reducer in `apps/web/src/app-state.ts` (verified: only `queryClient.invalidateQueries` is called on SSE events). So filtering must happen at READ time, not write time. Implementation:
  - Maintain a `Set<string>` of "optimistically removed" workspace ids in a React context (`OptimisticRemoveContext`) exposed from `cockpit.tsx`.
  - Wrap `useStateQuery` in a new `useFilteredStateQuery()` hook (same file) that returns the query result but with `workspaces` filtered to exclude any id in the blacklist set. All consumers of `useStateQuery` that render the workspace list switch to the wrapper.
  - The mutation's `onMutate` adds the id; `onSettled` removes it. No timer — survives slow teardowns (hook scripts can take minutes).
  - Test: "refetched `/api/state` during the optimistic-remove window does not resurrect the workspace in the rendered nav".
- **Toast surface**: no central toast today. Implementation: a bottom-right `<aside>` rendered from `cockpit.tsx`, driven by a `useState` queue exposed via React context with a minimal `pushToast({ tone, message })`. Auto-dismiss after 6s.
- **Rollback UX (hard requirement)**: when `removed === false` (or the mutation errors), in addition to the toast, re-open `DropWorkspaceDialog` for the resurrected workspace seeded with the error. This holds even when the user has navigated to a different workspace — the dialog re-opens within the cockpit shell. Tested explicitly: "rollback re-opens the drop dialog with the error message visible".
- **Selection collateral**: if the user dropped the currently-active workspace, the cockpit navigates to the next workspace immediately (alphabetical, or first in nav order — pick first-in-nav-order to honour the new local sort). The active-workspace selector in `cockpit.tsx` (currently `data.workspaces.find(...) ?? [...data.workspaces].sort(...)[0]` around lines 50–56) MUST consume the filtered list from `useFilteredStateQuery` so it never picks a blacklisted workspace as the fallback active. If rollback occurs, the active workspace pointer does NOT auto-revert; the resurrected row receives the auto-opened dialog instead. Tested explicitly: "rollback while user is on a different workspace shows the dialog without snapping focus back".

### Step 6.0 — Extract create/remove from `packages/operations/src/index.ts` (BLOCKS Step 6 — file-size gate)

The file is currently at 799/800 lines. Adding the new provisioning split, stage emitter, funny-name retry loop, and dirty-summary integration would push it well past the 800-line cap enforced by `scripts/checks/file-size.ts`. Extract first:

- New module `packages/operations/src/create-workspace.ts` mirroring the existing `launch-agent.ts` / `create-agent-session.ts` factoring:
  - Export `createWorkspaceModule(deps)` returning `{ beginCreateWorkspace, runWorkspaceProvisioning, createWorkspaceAndWait }`.
  - `deps` includes the store, activity logger, hook runner, operation upserter, etc. — the same dependencies the class methods use today via `this`.
- New module `packages/operations/src/remove-workspace.ts`:
  - Export `removeWorkspaceModule(deps)` returning `{ removeWorkspace }`.
  - Includes the `workspaceDirtySummary` invocation from Step 4.
- The class in `index.ts` retains thin delegator methods (`createWorkspace`, `removeWorkspace`) that call the extracted modules. Same external shape, so MCP/HTTP callers see no API change.
- **Dep-injection surface**: `createWorkspace` and `removeWorkspace` call several class-internal helpers (`this.operation`, `this.logOp`, `this.activity`, `this.runWorkspaceHooks`, `this.runNotificationHooks`, `this.store.upsertOperation`, etc.). Pass these to the extracted modules via bound references in `deps`, e.g. `{ operation: (...args) => this.operation(...args), logOp: (...args) => this.logOp(...args), ... }`. Mirrors the `launch-agent.ts` injection pattern, just with more deps (7 vs. 3).
- **Headroom checkpoint — projection FIRST, extraction second**: before writing delegator stubs, estimate the post-extraction line count by counting the lines you're about to move out (`createWorkspace` + `removeWorkspace` bodies ≈ 200 lines) versus the delegator overhead you're about to add (≈ 40 lines for two stubs + deps construction). If the projection exceeds 650 lines remaining in `index.ts`, do Step 6.0a FIRST: extract `operation`, `logOp`, `activity` helpers into `packages/operations/src/operation-helpers.ts`. Then proceed with Step 6.0b (create/remove extraction) using the helpers module directly — no `this.*` binding needed for those three deps. After landing, `wc -l packages/operations/src/index.ts` must be ≤ 650.
- Run `make check` after extraction to confirm file-size + architecture-boundary checks pass before adding any new code.

### Step 6 — Async create + setup-progress (AC3)
- **Daemon**: in the new `packages/operations/src/create-workspace.ts`:
  - `beginCreateWorkspace(input)` returns `{ operationId, workspaceId }` synchronously after the workspace record is inserted (lifecycle="creating") and the operation row is logged.
  - `runWorkspaceProvisioning(workspace, repo, input, operation, { onStage })` performs the fetch + addWorktree + setup-hooks block. Stages emitted via the injected callback: `fetching`, `adding-worktree`, `running-hooks`, `ready`, `failed`. Each carries a `message` string identical to the existing `upsertOperation({ message })` value, so the `Operation` row remains the durable mirror.
  - **Failure invariant (addresses C-NEW-3 — no orphan "creating" rows)**: `runWorkspaceProvisioning` body is wrapped in a try/catch. On ANY error path (including synchronous throws from deps, OOM, etc.), it sets `workspace.lifecycle = "failed"` AND `operation.status = "failed"` in the store BEFORE invoking `onStage("failed", message)`. The daemon's outer `.catch` becomes a pure safety-net logger — it never writes to the DB, only logs and emits a defensive "failed" SSE in case the inner catch itself crashed. Net result: no workspace ever stays in `lifecycle="creating"` after the daemon process is alive. Test: "runWorkspaceProvisioning sets lifecycle=failed and operation.status=failed on a synchronous throw from injected deps".
  - `createWorkspaceAndWait(input)` is `beginCreateWorkspace` followed by an awaited `runWorkspaceProvisioning` — used by `launchAgent` to preserve synchronous-create semantics for MCP callers.
- **Daemon HTTP route** (`apps/daemon/src/app.ts:485`):
  - When the request body has no `initialAgent`: call `beginCreateWorkspace`, kick off `runWorkspaceProvisioning(...)` without awaiting (`.catch(err => emit("workspace.setup.stage", { workspaceId, stage: "failed", message: ... }))`), respond `202` with `{ operationId, workspaceId }`.
  - When the request body has `initialAgent: { runtimeId, prompt }`: call `operations.launchAgent({ ...input, runtimeId, prompt })` — the existing composer. `launchAgent` already calls `createWorkspaceAndWait` then `createAgentSession`, emits `agent.updated`. Respond `202` with `{ operationId, workspaceId, sessionId }`. **Single composition path; no duplicated session-creation logic** (addresses reviewer Blocker 3).
  - Both paths call `emit("workspace.setup.stage", { workspaceId, stage, message })` via the injected `onStage`.
- **SSE event type**: the `emit` signature is stringly typed. Add `workspace.setup.stage` to whatever consumer parses events in `apps/web/src/app-state.ts`. Payload schema declared in `packages/contracts/src/index.ts` for zod validation on the receive side.
- **Web event reducer** (`apps/web/src/app-state.ts`): maintain `setupStageByWorkspaceId: Map<string, { stage: Stage; message: string; updatedAt: string }>`. Clear entries on `state.reconciled` if the workspace's `lifecycle === "ready"`.
- **SSE replay / cold-start mitigation (new substep, addresses reviewer Concern 4)**: SSE has no replay. On workspace-card mount, when `lifecycle === "creating"`, derive the initial stage label from `state.operations` filtered to `type === "workspace.create" && workspaceId === <id>`, picking the most recent. SSE events arriving subsequently override. Specifically: the workspace card reads `Operation.message` as the fallback stage label when `setupStageByWorkspaceId` has no entry. Add a unit test: "workspace card mounted mid-provision reads latest stage from operations row".
- **Operation-log link (suggestion 13)**: the stage label on the workspace card is a clickable link that opens the existing operation log viewer pinned to this `operationId`. Cheap; satisfies "see what's happening".
- **Modal**: in `apps/web/src/modals.tsx:362` (`CreateWorkspaceModal`), close immediately on submit:
  - Build the `{ initialAgent }` body when `runtimeId` is set, else a bare body.
  - Kick `create.mutate()`. Synchronously call `props.onClose()` right after `mutate()` is called — do NOT await. The mutation's `onSuccess` is no longer responsible for closing; it only routes `onCreated(workspaceId)` (which already calls `onPickWorkspace`).
  - On mutation error, surface a toast (reuses Step 5's toast infrastructure) — the modal is gone.
- **Workspace card**: when `workspace.lifecycle === "creating"`, render an inline progress overlay (one-line stage label + spinner) that links to the operation log. When `lifecycle === "failed"`, render a danger-toned banner with the last stage message and a "Retry" action (re-issues the create) plus the existing drop button.
- **Drop button gating (reviewer Concern 11)**: the drop button is disabled when `(workspace.lifecycle === "creating") || drop.isPending`. Stays clickable on `failed` (so the user can clean up).
- **Stage "+" button gating (suggestion 14)**: in `apps/web/src/stage.tsx`, the "+" add-session button is disabled when `workspace.lifecycle === "creating"`. Reuses the existing `addDisabled` flag.

### Step 7 — Wire-up + regressions
- **`launch_agent` MCP path unchanged**: `launchAgent` keeps calling `createWorkspaceAndWait` synchronously. No new branch.
- **HTTP `initialAgent` payload** is the ONLY new contract surface. It routes through `launchAgent`, so the existing `launchAgent` tests already cover most of the integration; only the daemon route handler is new.
- **Smoke** (suggestion 15): `make smoke` adds an assertion that `POST /api/workspaces` with `{ initialAgent: { runtimeId, prompt } }` returns 202 with `{ operationId, workspaceId, sessionId }`.

## Migration strategy

No schema changes. The `Workspace.lifecycle` enum (`creating | ready | failed`) is reused as-is. The `schema_migrations` table is not touched. `PRAGMA foreign_keys = ON;` not affected. Operator data implications: existing databases continue to work unchanged; the new SSE event type is an additive surface that older clients can simply ignore.

## Hard gate compliance

- **Spec gate**: Step 0 updates `specs/B.1-repositories-workspaces.md` and `specs/B.2-ade-cockpit.md` with concrete clauses for each AC. New behaviors are landed as `[ ]` "target behavior" entries until the PR merges, then flipped to `[x]` in the same PR (per the spec status legend at `specs/A-shared-definitions.md`).
- **Regression test gate**: prefer extending `apps/web/src/workspace-card.test.ts`, `packages/operations/src/helpers.test.ts`, `packages/operations/src/index.test.ts`. New test files (`navigator-order.test.ts`, `stage.test.ts`, `modals.test.ts`, `funny-name.test.ts`) are created only where no existing test surface covers the area.
- **Architecture-boundary gate**: `packages/core/src/funny-name.ts` is a pure helper with no forbidden imports. No new daemon imports from web. No new cross-package imports.
- **Schema-safety gate**: N/A — no schema changes.
- **File-size gate**: Step 6.0 extracts `createWorkspace`/`removeWorkspace` from the already-at-799-lines `packages/operations/src/index.ts` BEFORE adding new code, so the file does not breach 800 lines. All other touched files are under 500 lines today.
- **Provider-degradation gate**: N/A — no provider-backed code touched.
- **Workspace-cleanup-safety gate**: this plan does NOT add any new force-cleanup path. Dirty workspaces remain blocked from removal (the existing dirty short-circuit at `packages/operations/src/index.ts:423` is preserved unchanged; we only attach a `dirtySummary` to the blocked-response). No dirty deletion without explicit force flag.
- **Terminal-completeness gate**: AC6 only programmatically focuses the iframe element — no PTY/xterm internals touched.
- **Lockfile-sensitivity gate**: no new dependencies. Native HTML5 drag API used instead of a dnd library.

## QA/Test Strategy

### Layer evaluation
| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | Required | New: funny-name generator, dirty-summary helper, navigator-order helper, async-create stage emitter, optimistic-remove rollback. Updated: existing operations tests for `createWorkspace` + `removeWorkspace`. Target ≥ 90% line coverage on touched modules. |
| E2E (Playwright) | Required | Touches `apps/web` user journeys (nav, create modal, drop dialog) AND daemon HTTP contract (`POST /api/workspaces` now returns 202 with pending lifecycle, `DELETE /api/workspaces/:id` now returns dirty summary). Single happy-path E2E covers: create workspace → modal closes → setup-progress visible → ready → drop with no dirty → optimistic removal → row gone. A second E2E covers the dirty-block path: create → make commit → drop → dialog shows file list. |

### New tests to add
- `packages/core/src/funny-name.test.ts` — `generateFunnyName()`:
  - "returns a kebab-cased adjective-animal pair"
  - "draws from the full dictionary given a deterministic picker"
  - "does not return the same name twice across N=200 calls with random picker" (probabilistic; cap acceptable collisions)
- `packages/operations/src/helpers.test.ts` (new or extend existing) — `workspaceDirtySummary()`:
  - "returns empty arrays for a clean worktree"
  - "lists modified file paths with porcelain status codes"
  - "lists unpushed commit shas and subjects when `@{u}` resolves and ahead > 0"
  - "uses the rev-list fallback when `@{u}` does not resolve"
  - "caps files at 50 and commits at 20"
- `packages/operations/src/index.test.ts` (extend) — `createWorkspace` + `runWorkspaceProvisioning`:
  - "begin returns immediately after DB insert with operationId+workspaceId" (verify by mocking `runWorkspaceProvisioning` to never resolve)
  - "runWorkspaceProvisioning emits stages in order: fetching → adding-worktree → running-hooks → ready"
  - "emits `failed` stage and sets lifecycle to `failed` on hook error"
  - "runWorkspaceProvisioning sets lifecycle=failed and operation.status=failed on a synchronous throw from injected deps"
  - "funny-name generation retries on unique-name collision up to 5 times"
- `packages/operations/src/index.test.ts` (extend) — `removeWorkspace`:
  - "returns dirtySummary when worktree is dirty"
  - "omits dirtySummary on successful removal"
- `apps/web/src/navigator-order.test.ts` (new) — `applyLocalOrder()`:
  - "puts entries listed in idOrder first in the given order"
  - "appends entries not in idOrder in their default order"
  - "drops idOrder entries that don't exist in entries (stale ids)"
- `apps/web/src/stage.test.ts` (new or extend if exists) — close-active-tab focus:
  - "clicking close on the active tab focuses the LEFT sibling before mutating"
  - "clicking close on a non-active tab doesn't change activeSessionId"
  - "closing the only tab leaves activeSessionId untouched"
- `apps/web/src/workspace-card.test.ts` (extend — file already exists per `apps/web/src/workspace-card.test.ts`):
  - "DropWorkspaceDialog renders dirtySummary file list when result.dirtySummary is present"
  - "DropWorkspaceDialog renders unpushed-commit list with short shas"
  - "optimistic removal updates state cache on mutate"
  - "optimistic removal rolls back when removed === false"
  - "onClick calls onPickWorkspace then focuses the active terminal handle"
  - "onClick on a session-less workspace does not throw and does not focus any iframe"
  - "useFilteredStateQuery subtracts blacklisted workspace ids from `workspaces[]` until onSettled clears the id"
- `apps/web/src/modals.test.ts` (new or extend) — GroupByMenu + CreateWorkspaceModal:
  - "GroupByMenu closes when clicking outside both the menu AND the trigger button"
  - "GroupByMenu does NOT close when clicking the trigger button (allows toggling)"
  - "CreateWorkspaceModal calls onClose synchronously when submit is clicked (does not await POST)"
- `e2e/workspace-nav-lifecycle.spec.ts` (new):
  - happy path: create from modal → modal closes → workspace card visible in nav with `lifecycle="creating"` → eventually `lifecycle="ready"` → drop card → row disappears optimistically. **Do NOT assert per-stage labels** — local provisioning is too fast (<100ms with no hooks) for Playwright to reliably observe transient stages. Per-stage emission is unit-tested on `runWorkspaceProvisioning`.
  - dirty-block: create → seed a dirty file via test helper → drop → dialog shows file list with the seeded path
  - rollback re-open: stub the daemon DELETE to return `{ removed: false, dirty: false, error: "teardown_failed" }` → drop a workspace → confirm the dialog re-opens with the error message

### Existing tests to update
- `apps/web/src/workspace-card.test.ts` — add cases per above; existing assertions stay.
- `packages/operations/src/index.test.ts` — current `createWorkspace` tests likely assume the synchronous shape; update them to either (a) drive the awaited variant `createWorkspaceAndWait` for the `launchAgent` flow, or (b) call `beginCreateWorkspace` + `runWorkspaceProvisioning` separately.
- `e2e/*.spec.ts` — any test that creates a workspace through the modal must be updated for the new async behavior (modal closes immediately).

### Assertions to add/change/tighten
- Tighten: in `DropWorkspaceDialog`, when `dirtyBlocked` is true, assert the dialog renders structured summary (file count > 0 OR commit count > 0), not just the generic copy.
- Add: SSE-stage receipt asserts that the `stage` field is one of the literal union members; rejects unknown stages in the contract schema (zod).
- Add: navigator order persistence — after reload, the rendered DOM order matches the localStorage order.
- Add: terminal-focus on workspace select — assert `iframe.contentWindow.focus` is invoked (mock the handle).
- Add: optimistic-remove rollback — assert the workspace row is back in the DOM after `removed: false` response.

### Failure modes / edge cases / regression risks
- **Race: SSE stage event arrives BEFORE the React Query refetch surfaces the new workspace in state.** Mitigation: the stage-event reducer must tolerate `workspaceId` not yet known and either buffer briefly or rely on the post-refetch `lifecycle="creating"` to anchor the stage label.
- **Race: user clicks Drop on a workspace whose creation hasn't finished.** Today `removeWorkspace` would partially run; with `lifecycle="creating"`, mitigation is to disable the drop button while `lifecycle !== "ready" && lifecycle !== "failed"`.
- **Provisioning failure leaves an orphan worktree dir** if `addWorktree` succeeds but hooks fail. Existing code marks `lifecycle="failed"` but does NOT remove the worktree. We don't change that behavior — but document it in the spec clause and surface a retry/remove action on the failed-state card so the user can recover.
- **Drag-reorder + grouping change**: if the user drags within `repo` grouping then switches to `status` grouping, the order from `repo` shouldn't bleed across. The order key includes the group path; switching grouping selects a different key.
- **Drag-reorder + workspace removal**: a removed workspace's id stays in localStorage briefly. Garbage-collect on mount by intersecting with live ids (mirrors the existing collapsed-pruning effect at `navigator.tsx:121`–`:135`).
- **Funny-name dictionary collisions with real Jira keys**: shouldn't happen since Jira keys are uppercase, generated names are lowercase. Still, the daemon-side uniqueness check is authoritative.
- **Optimistic remove vs. background data refresh**: the cockpit's cache repopulates via `useStateQuery`'s 5s refetch + post-`invalidateQueries` refetch — no SSE payload reducer exists. Filtering happens at READ time via the wrapper `useFilteredStateQuery` hook: while a workspace id is in the `OptimisticRemoveContext` Set, the wrapper subtracts it from `workspaces[]` before returning. `onMutate` adds the id; `onSettled` removes it. Mutation-lifecycle, not TTL — survives slow teardowns (hook scripts can take minutes).
- **Inspector collapse glyph change**: cosmetic; smoke check the existing `aria-label="Collapse inspector"` stays unchanged (screen-reader regression risk is low).
- **Closing the active agent during a `keepPending` window** (e.g. just after starting a new session): the existing 4s grace exists exactly for this. Ensure the new pre-pick logic doesn't preempt the grace when the pending id was set by `startSession`, not by user navigation. Heuristic: only pre-pick when the active tab is in the current tabs list at the moment of the close click.

### Adversarial analysis
- **How could this fail in production?** Most likely: an async-create race where the workspace card mounts before the SSE event listener is wired, leaving the card stuck on "Starting…". Mitigation: read `Operation` rows that are still `running` for the workspace at first render and use their `message` as the initial stage label.
- **What user actions trigger unexpected behavior?** Rapidly dropping a workspace while it's still provisioning. We disable the drop button on `lifecycle="creating"` (see edge cases).
- **What existing behavior could break?** The MCP `launch_agent` flow depends on synchronous worktree creation. Step 7 preserves that via `createWorkspaceAndWait`.
- **Which tests credibly catch those failures?** The new operations test "begin returns immediately" + the existing `launchAgent` tests (must continue to pass against `createWorkspaceAndWait`). The E2E happy path catches the SSE wiring.
- **What gaps remain?** Cross-grouping drag-reorder isn't supported. Server-side persisted ordering is deferred. The toast surface is intentionally minimal — accessibility audit pending. Setup-progress UI does not yet expose log tail; only the latest stage message.

## Tests
TDD order, per Implementation step:
1. `packages/core/src/funny-name.test.ts` → `packages/core/src/funny-name.ts`.
2. `packages/operations/src/helpers.test.ts` (extend) → `workspaceDirtySummary` in `helpers.ts`.
3. `packages/operations/src/index.test.ts` (extend) → split `createWorkspace`; funny-name daemon retry loop; `removeWorkspace` summary.
4. `apps/web/src/navigator-order.test.ts` → `apps/web/src/navigator-order.ts`.
5. `apps/web/src/stage.test.ts` → close-tab pre-pick.
6. `apps/web/src/workspace-card.test.ts` (extend) → optimistic remove, dirty summary, focus terminal.
7. `apps/web/src/modals.test.ts` → GroupByMenu close + modal close-on-submit.
8. `e2e/workspace-nav-lifecycle.spec.ts` → end-to-end create/drop loop.

## Schema or contract generation
- Contracts (`packages/contracts/src/index.ts`) gain optional `dirtySummary` on the workspace-remove result and a new event-type literal `"workspace.setup.stage"` with payload schema. If the repo regenerates types from zod schemas via `pnpm build` only, no separate codegen step is needed.

## Verification

Pre-PR gate (must all pass):
- `make check` — `check:arch`, `check:size`, `typecheck`, biome lint, vitest, vitest coverage, `check:deps`, build. Comprehensive local gate per `.agents/skills/extensions/do-tech-plan.md`.
- `make e2e` — Playwright. New `e2e/workspace-nav-lifecycle.spec.ts` must be green; existing specs that create workspaces through the modal must be updated and pass.
- `make smoke` — daemon HTTP smoke. Required because we are changing the `POST /api/workspaces` response shape (202 + pending lifecycle) and the `DELETE /api/workspaces/:id` response shape (new optional `dirtySummary`).

Post-PR browser verification (per CLAUDE.md "UI or frontend changes" rule): run `make deploy`, open the cockpit URL it prints, walk through:
- Create a workspace with no name → confirm the modal closes immediately and the card shows stage labels progressing.
- Switch to another workspace while it's still bootstrapping → confirm it keeps bootstrapping in the background and the row updates when ready.
- Make a dirty file, then drop the workspace → confirm the dialog shows the file with its porcelain status code.
- Drop a clean workspace → confirm the row disappears immediately.
- Drag a workspace within its group to a new position → reload → confirm the order persists.
- Open the group-by menu → click outside → confirm it closes.
- Open inspector → click the collapse button → confirm it uses the chevron icon and collapses correctly.
- Close the active agent tab → confirm focus jumps immediately to the sibling tab (no 4s blank).
