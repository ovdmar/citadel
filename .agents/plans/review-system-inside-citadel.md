Activate the /implement-task skill first.

# Plan: Review system inside Citadel

## Acceptance Criteria

Requirements came from the user prompt (free text, no ticket). Verbatim source:

> - "Request review" button with a repo-configurable hook for custom "review suggestions" logic
> - Citadel-native review on PRs: comments stored in citadel (not GitHub), readable by agents via MCP

Derived acceptance criteria (each must be checkable):

- [ ] AC1 — A repo can declare a `workspace.requestReview` hook in `citadel.config.json` (new variant of `HookEventSchema` in `@citadel/config`); validation rejects unknown ids and accepts the new event. Authored hooks of this event default to `blocking: true` (added to the existing default-true list).
- [ ] AC2 — On a workspace inspector view that has a PR (or is on a non-default branch), a "Request review" button is visible. When the active repo has no `workspace.requestReview` hook configured, the button is disabled with a tooltip explaining how to wire one up.
- [ ] AC3 — Clicking "Request review" runs the configured hook with a structured payload (`{ workspace, repo, pr, diff: { files: string[], addedLines, deletedLines, truncated } }`) and renders the returned suggestions in a panel under the button. Errors and timeouts surface inline (do not crash the inspector).
- [ ] AC4 — Each request-review invocation is recorded as a single `activity_events` row (`hook.workspace.requestReview` on success / `hook.workspace.requestReview.failed` on failure or timeout) AND as a `review_suggestion_runs` row with the parsed structured payload (or stderr/error on failure), so the latest suggestions survive a reload.
- [ ] AC5 — From the inspector, an operator can add a Citadel-native review comment scoped to: (a) the whole workspace/PR, or (b) a specific file, or (c) a specific file + line range. Comments are stored in SQLite, not posted to GitHub.
- [ ] AC6 — Comments support: edit body, mark resolved/unresolved, soft-delete by author. The list is **flat** (no threading in v1). UI shows author, timestamp, status, and any file:line anchor. Update/delete requests carry an optimistic-concurrency `ifUpdatedAtMatches` token; mismatched tokens return 409 Conflict.
- [ ] AC7 — A new MCP read-only tool `list_review_comments({ workspaceId, status?, includeDeleted? })` returns the comment list (newest first by default) with all anchor metadata. `includeDeleted` defaults to false.
- [ ] AC8 — A new daemon-mediated MCP tool `add_review_comment({ workspaceId, body, filePath?, lineStart?, lineEnd?, side? })` persists a new comment. The MCP path forces `author = 'agent:<runtime-id>'` (callers cannot supply `author`). HTTP route from the cockpit forces `author = 'operator'`. `update_review_comment` and `delete_review_comment` mirror the UI mutations with `ifUpdatedAtMatches`.
- [ ] AC9 — A new daemon-mediated MCP tool `request_review({ workspaceId })` triggers the hook on the daemon side and returns the structured suggestions (or a structured error if no hook is configured / parse failed / timed out).
- [ ] AC10 — SQLite schema is at version 8 after upgrade, with new tables `review_comments` and `review_suggestion_runs`; existing installs running the new schema on startup are unaffected (no destructive DDL, FKs preserved, `PRAGMA foreign_keys = ON` intact).
- [ ] AC11 — Suggestion output schema is validated by zod at hook-parse time (bad output fails parse, surfaces in the suggestion run + activity feed with a `failed` status, does not write a partial payload). An empty stdout is a successful run with zero suggestions and renders an explicit empty state in the UI.
- [ ] AC12 — Hook execution reuses the existing `runCommandHookForDiagnostics` runner via the existing `commandHook()` adapter in `packages/operations/src/hooks-runner.ts`; the operations service catches the runner's timeout rejection and writes the row with status `timed_out`.

## Context and problem statement

Citadel today exposes PR meta (URL, draft state, review decision, reviewer counts) and a diff endpoint, but has no first-class "review" surface inside the cockpit. Spec `specs/B.4-git-pr-ci-diff.md` § "Human Review (Planned)" items [ ] 1–5 reserve this product area:

> A future full-screen *Human Review* mode is reachable from the inspector `Diff` tab. Human Review allows leaving file/line comments. Comments are visible to the active agent session as structured input.

The user wants two related surfaces shipped together:

1. **Request review** — a workspace-level button that calls a repo-configurable hook and shows the hook's "review suggestions" (e.g., a generated reviewer list, a checklist of risk areas, links to docs). This is the extension point for any custom team workflow (CODEOWNERS-style suggestions, LLM-generated checklist, on-call lookup, etc.). Hook output is opaque to Citadel beyond schema validation.

2. **Citadel-native review comments** — file/line and workspace-level comments stored in Citadel's SQLite DB (not posted to GitHub). Comments are readable by agents via MCP, so an agent session attached to the workspace can pick up operator feedback as structured input. This is the foundational store for the full GitHub-style review mode (spec B.4 [ ] 1–4); v1 ships the store + MCP surface + a minimal inspector tab. The full file-and-line-anchored inline rendering inside a diff viewer is deliberately out of scope for v1 (tracked in spec B.4 [ ] 2 as a follow-up). **Threading is also deferred** — v1 ships a flat list (no `parent_id`).

Why now: scratchpad-style ad-hoc notes (B.7 § Scratchpad) work for free-form ideas, but they don't anchor to a PR's files/lines and they aren't queryable as "comments on this PR". An agent reviewing a workspace's diff via MCP currently has no way to read structured operator feedback scoped to that PR.

## Spec alignment

Specs touched:

- `specs/B.4-git-pr-ci-diff.md` — advances "Human Review (Planned)" items [ ] 3, 4, 5 from planned to partial (`[~]`). v1 ships items 3 (file/line comments), 4 (agent-visible structured input via MCP), 5 (scoped to selected workspace). Item 1 (full-screen review mode reachable from the `Diff` tab) is partially advanced: this plan adds a `Review` tab/section in the inspector, not a full-screen surface — keep item 1 as planned. Item 2 (GitHub-style review surface) stays planned. **Add a retention note**: v1 has no retention policy for `review_suggestion_runs` or `activity_events`; both grow unbounded. Bulk-resolve/delete on merged PRs is a follow-up.
- `specs/B.6-providers-hooks-config.md` — extends the Hooks subsection ([ ] 1–10): adds `workspace.requestReview` as a sixth hook type. Note that this hook returns the dedicated `ReviewSuggestionsOutput` schema (not the generic `HookOutput`), and defaults to `blocking: true` like setup/teardown.
- `specs/B.7-operations-activity-mcp.md` — extends "MCP tool inventory" with new read-only / mutating tools (`list_review_comments`, `add_review_comment`/`update_review_comment`/`delete_review_comment`, `request_review`). Activity items [ ] 2, 4, 7 are reinforced by the new event types `hook.workspace.requestReview[.failed]` and `review.comment.{added,updated,resolved,deleted}`.

Discrepancies / divergences:

- None of these are *contradictions* with the specs; they are advancements of items currently marked `[ ]`. The plan's **first implementation step** is to update specs B.4, B.6, B.7 to reflect the new state.
- `specs/A-shared-definitions.md` Core Terms list does not need a new term ("Review" is implicit under PR/Workspace).

## Implementation approach

**Chosen strategy: thin, additive vertical slice that lands the data model + hook + MCP surface + minimal UI together.**

Concretely:

1. **Contracts first.** Create a new file `packages/contracts/src/review.ts` (mirrors the existing `packages/contracts/src/scratchpad.ts` split pattern). Add `ReviewSuggestionSchema`, `ReviewSuggestionsOutputSchema`, `ReviewCommentSchema`, `ReviewSuggestionRunSchema`, `RequestReviewPayloadSchema`. Re-export from `packages/contracts/src/index.ts`. Keep `index.ts` under the 800-line file-size limit (it is 794 lines today).

2. **Config layer.** In `packages/config/src/index.ts`:
   - Extend `HookEventSchema` (lines 41-50) with `"workspace.requestReview"`.
   - Extend `HookConfigSchema.transform` blocking-default array (lines 65-68) to include `workspace.requestReview` (so authored hooks default to `blocking: true`).
   - Extend the inline `repoDefaults` object literal (lines 133-140) with `requestReviewHookIds: z.array(z.string()).default([])`. Update the outer `.default({...})` to include `requestReviewHookIds: []`.
   - Extend the `.superRefine` block (lines 169-176) with a new `validateHookReferences(context, hooksById, config.repoDefaults.requestReviewHookIds, "workspace.requestReview", ["repoDefaults", "requestReviewHookIds"])` call.

3. **DB layer.** Add two tables (`review_comments`, `review_suggestion_runs`) to `packages/db/src/migrate.ts`, bump `schema_migrations` to version 8 with name `review-system`. Add typed accessors in `packages/db/src` (mirror the shape used by activity/operations accessors).

4. **Hook runner.** No new code in `packages/hooks` — existing `runCommandHookForDiagnostics` is reused. Add a `parseReviewSuggestionsOutput()` helper next to `parseHookOutput()` in `packages/hooks/src/index.ts`.

5. **Operations service.** Reuse the existing `commandHook(hook, workspacePath, config)` adapter from `packages/operations/src/hooks-runner.ts:21` (lift to a shared exported helper in `hooks-runner.ts` if it isn't already exported, or import the file's internal helper via a small refactor: export `commandHook`). Add `requestReviewForWorkspace(deps, workspaceId)`:
   - Resolve workspace + repo + the configured `workspace.requestReview` hook id.
   - If no hook configured → return `{ kind: 'no-hook' }`.
   - Build payload, call `runCommandHookForDiagnostics(commandHook(...), payload)` wrapped in try/catch.
   - On resolved success (`exitStatus === 0`): parse output (treat empty as zero suggestions), insert `review_suggestion_runs` with status `succeeded`, append one `activity_events` row of type `hook.workspace.requestReview`, return parsed suggestions.
   - On resolved non-zero exit: insert run with status `failed`, append activity `hook.workspace.requestReview.failed`, return structured error including stderr tail.
   - On rejection (timeout / spawn failure): detect timeout by matching the rejection's message text (the runner produces `"Hook timed out after ${timeoutMs}ms"`); insert run with status `timed_out` (or `failed` for other rejections); append activity `hook.workspace.requestReview.failed`; return structured error. Track wall-clock elapsed as a backup signal in case the message text changes.
   - Add comment service: `listReviewComments`, `addReviewComment`, `updateReviewComment`, `deleteReviewComment`. Each mutation appends one activity row (`review.comment.added`, `review.comment.updated`, `review.comment.resolved`, `review.comment.deleted`). Update/delete take `ifUpdatedAtMatches` (string ISO) and return `{ status: 'conflict', latest: <row> }` on mismatch. `listReviewComments` filters out comments whose workspace is archived by default (`workspaces.archived_at IS NULL`); explicit `includeArchived: true` opt-in for admin reads.

6. **Daemon HTTP.** New routes in `apps/daemon/src/review-routes.ts`:
   - `POST /api/workspaces/:id/review-requests` → calls `requestReviewForWorkspace`, returns the parsed suggestions or `{ error: { code, message } }`.
   - `GET /api/workspaces/:id/review-suggestions` → returns the latest `review_suggestion_runs` row.
   - `GET /api/workspaces/:id/review-comments?status=open|resolved|all&includeDeleted=true` → list. Default: `status=all`, `includeDeleted=false`. Forces `author='operator'` not applicable to GET.
   - `POST /api/workspaces/:id/review-comments` → create; forces `author='operator'` on the inserted row regardless of request body.
   - `PATCH /api/review-comments/:id` → edit body / status. Requires header or body field `ifUpdatedAtMatches`. 409 on mismatch.
   - `DELETE /api/review-comments/:id` → soft-delete with `ifUpdatedAtMatches`. 409 on mismatch.

7. **MCP surface.** Register in `packages/mcp/src/index.ts`:
   - Read-only: `list_review_comments({ workspaceId, status?, includeDeleted? })`.
   - Daemon-mediated: `add_review_comment` (no `author` accepted; daemon stamps `agent:<runtime-id>`), `update_review_comment` (with `ifUpdatedAtMatches`), `delete_review_comment` (with `ifUpdatedAtMatches`), `request_review`.
   - Wire daemon-side implementations in `apps/daemon/src/daemon-mcp-tool.ts`. Daemon-side handlers extract the active MCP client's runtime id from the request context (or fallback to `'agent:unknown'`). Schema validation **rejects** an MCP `add_review_comment` request that supplies an `author` field.

8. **Cockpit UI.** Three pieces in `apps/web/src/`:
   - A "Request review" button + collapsible suggestions panel placed in the inspector PR meta row (or as a new "Review" sub-section above the Diff tab). Renders the empty-state when the latest run has zero suggestions ("Hook returned no suggestions").
   - A "Review" tab in the inspector (next to Diff) with: a "new comment" composer (body + optional file selector populated from the workspace diff + optional line range) and a flat list of comments (open first, resolved collapsed).
   - HTTP client helpers colocated with the inspector files (or under `apps/web/src/api/` if that's the convention).

9. **Activity wiring.** Every mutation routes through the operations service and writes one `activity_events` row. Event types (final list, no duplicates):
   - Hook lifecycle: `hook.workspace.requestReview`, `hook.workspace.requestReview.failed`.
   - Comment mutations: `review.comment.added`, `review.comment.updated`, `review.comment.resolved`, `review.comment.deleted`.

**Rationale.** This slice ships both halves end-to-end without the full inline-diff renderer or threading. The hook contract is intentionally generic so teams can implement varied logic. Comments live in their own tables (status, FKs, soft-delete) because `activity_events` is append-only.

## Alternatives considered

- **Alternative A: Reuse `HookOutputSchema.actions`/`links` for review suggestions.** Rejected. `HookOutputSchema` is shaped for app/link discovery; cramming `kind: reviewer` into `actions` blurs the data model and forces UI shape-sniffing. A purpose-built `ReviewSuggestionsOutputSchema` is one extra type for clarity.

- **Alternative B: Store comments in the scratchpad (block model).** Rejected. Scratchpads are workspace-global free-form notes; they are not file/line anchored, not threaded, not status-trackable, and not scoped to a PR. Borrowing the block model would re-implement all of the above on a parser with known edge cases.

- **Alternative C: Post comments to GitHub via the provider.** Rejected by the user's brief and by Citadel's local-first model (provider may be unhealthy; comments must be readable offline).

- **Alternative D: Ship the full inline-diff comment renderer in v1.** Rejected as too large for one PR.

- **Alternative E: Refactor `runCommandHookForDiagnostics` to resolve on timeout instead of rejecting.** Considered. Would be cleaner long-term but touches every existing hook runner (setup/teardown/apps/action), expanding blast radius. Rejected for v1; logged as a follow-up. The operations service catches the rejection text instead.

## Implementation steps

### Step 1 — Update specs (FIRST)

- Edit `specs/B.4-git-pr-ci-diff.md`: change Human Review items [ ] 3, 4, 5 to `[~]` with a note that the data store + MCP surface ship in this PR. Add a "Retention" note: `review_suggestion_runs` and `activity_events` have no retention policy in v1; bulk-resolve / delete on merged PRs is a follow-up.
- Edit `specs/B.6-providers-hooks-config.md`: add `workspace.requestReview` to the Hooks subsection. Note its dedicated output schema and default-blocking behavior.
- Edit `specs/B.7-operations-activity-mcp.md`: append to "MCP tool inventory" — `list_review_comments` under read-only; `add_review_comment`, `update_review_comment`, `delete_review_comment` (destructive), `request_review` under daemon-mediated. Note that MCP `add_review_comment` rejects caller-supplied `author`; daemon stamps `agent:<runtime-id>`.

### Step 2 — Contracts (`packages/contracts/src/review.ts` — NEW)

Create a new file under `packages/contracts/src/review.ts` and re-export from `index.ts` (mirroring the `scratchpad.ts` split at line ~786 of `index.ts`). Schemas:

- `ReviewSuggestionKindSchema = z.enum(["reviewer","checklist","note","warning"])`.
- `ReviewSuggestionSchema = z.object({ id: z.string().min(1), kind: ReviewSuggestionKindSchema, label: z.string().min(1).max(200), detail: z.string().max(2000).nullable().default(null), url: z.string().url().nullable().default(null), metadata: z.record(z.unknown()).default({}) })`.
- `ReviewSuggestionsOutputSchema = z.object({ suggestions: z.array(ReviewSuggestionSchema).max(50).default([]), generatedAt: z.string().nullable().default(null), metadata: z.record(z.unknown()).default({}) })` — each nullable field declared with `.nullable().default(null)` so a fully-omitted object parses without missing-key errors. NO outer `.default(...)`.
- `ReviewCommentStatusSchema = z.enum(["open","resolved"])`.
- `ReviewCommentSchema = z.object({ id, workspaceId, filePath: z.string().max(512).nullable().default(null), lineStart: z.number().int().min(1).nullable().default(null), lineEnd: z.number().int().min(1).nullable().default(null), side: z.enum(["LEFT","RIGHT"]).nullable().default(null), author: z.string().max(80), body: z.string().min(1).max(8000), status: ReviewCommentStatusSchema.default("open"), createdAt, updatedAt, deletedAt: z.string().nullable().default(null) })` with a `.superRefine` enforcing `lineEnd >= lineStart` when both set, and rejecting `lineStart/lineEnd/side` when `filePath` is null. NOTE: no `parentId` and no `prUrl` columns — v1 is flat and pr_url is joined from the workspace.
- `ReviewSuggestionRunSchema = z.object({ id, workspaceId, hookId, status: z.enum(["succeeded","failed","timed_out"]), durationMs: z.number().int().nullable().default(null), exitStatus: z.number().int().nullable().default(null), output: ReviewSuggestionsOutputSchema.nullable().default(null), stderr: z.string().nullable().default(null), error: z.string().nullable().default(null), createdAt })`.
- `RequestReviewPayloadSchema = z.object({ event: z.literal("workspace.requestReview"), workspace, repo, pr: z.object({ url: z.string().nullable(), branch: z.string(), baseBranch: z.string() }), diff: z.object({ files: z.array(z.string()), addedLines: z.number().int().nonnegative(), deletedLines: z.number().int().nonnegative(), truncated: z.boolean() }) })` — `files` is paths only to keep the payload bounded.

Re-export from `packages/contracts/src/index.ts`:
```ts
export * from "./review.js";
```
Add the inferred TS types alongside the re-export (or inside `review.ts`).

### Step 3 — DB schema (`packages/db/src/migrate.ts`)

Migration strategy (per repo extension):

1. **Operation list.**
   - `CREATE TABLE IF NOT EXISTS review_comments(...)`.
   - `CREATE INDEX IF NOT EXISTS idx_review_comments_workspace ON review_comments(workspace_id, created_at)`.
   - `CREATE INDEX IF NOT EXISTS idx_review_comments_status ON review_comments(workspace_id, status)`.
   - `CREATE TABLE IF NOT EXISTS review_suggestion_runs(...)`.
   - `CREATE INDEX IF NOT EXISTS idx_review_suggestion_runs_workspace ON review_suggestion_runs(workspace_id, created_at)`.
   - `INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES (8, 'review-system', datetime('now'))`.
2. **Classification.** All operations are **additive** (new tables + new indexes). No `DROP`, no `ALTER`, no type narrowing. Safe in one step.
3. **`schema_migrations` row.** New version `8`, name `review-system`. Strictly greater than the current max (`7`).
4. **`PRAGMA foreign_keys = ON;` preservation.** Connection open path is unchanged. FKs to `workspaces(id)` declared with `ON DELETE CASCADE` for hard deletes; archived workspaces are filtered at the query layer instead (see Step 5 — `listReviewComments` joins `workspaces.archived_at IS NULL`).
5. **Operator data implications.** Every existing install starts with zero rows in both new tables — additive. No backfill, no constraint-violation risk. The migration is a no-op on its second run.

Concrete DDL:

```sql
CREATE TABLE IF NOT EXISTS review_comments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  file_path TEXT,
  line_start INTEGER,
  line_end INTEGER,
  side TEXT CHECK (side IS NULL OR side IN ('LEFT','RIGHT')),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','resolved')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS review_suggestion_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  hook_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('succeeded','failed','timed_out')),
  duration_ms INTEGER,
  exit_status INTEGER,
  output_json TEXT,                 -- parsed ReviewSuggestionsOutput on success ONLY; NULL on failure
  stderr TEXT,                      -- raw stderr tail (success or failure)
  error TEXT,                       -- failure message (NULL on success)
  created_at TEXT NOT NULL
);
```

### Step 4 — DB accessors (`packages/db/src/`)

- `listReviewComments(workspaceId, opts: { status?: 'open'|'resolved'|'all'; includeDeleted?: boolean; includeArchived?: boolean })` — by default joins `workspaces` and excludes archived; ordering newest-first.
- `insertReviewComment(input)` returns the persisted row.
- `updateReviewComment(id, patch, ifUpdatedAtMatches)` — returns `{ kind: 'updated', row }` or `{ kind: 'conflict', latest }` when `updated_at` differs from `ifUpdatedAtMatches`. Body/status only.
- `softDeleteReviewComment(id, ifUpdatedAtMatches)` — same conflict semantics; sets `deleted_at`.
- `insertReviewSuggestionRun(input)`.
- `latestReviewSuggestionRun(workspaceId)`.

### Step 5 — Hook integration (`packages/hooks/src/index.ts`)

- Add `parseReviewSuggestionsOutput(stdout)` mirroring `parseHookOutput` but validating against `ReviewSuggestionsOutputSchema`. Empty trimmed stdout returns `null`; the operations service interprets `null` as "succeeded with zero suggestions". Truncated stdout (>64KB hits the slice limit) is detected by JSON.parse failure — surface a clear error message that mentions stdout truncation.
- No other changes (reuse `runCommandHookForDiagnostics`).

### Step 6 — Operations service (`packages/operations/src/review-system.ts` — NEW)

- Export the existing `commandHook(hook, workspacePath, config)` helper from `packages/operations/src/hooks-runner.ts` (one-line export change) and import it in `review-system.ts`.
- `requestReviewForWorkspace(deps, workspaceId)` implements the flow described in "Implementation approach § 5". Catches the runner rejection; detects timeout via message text (`"Hook timed out after"`) and via wall-clock elapsed-time backup signal.
- Comment service functions `listReviewComments`, `addReviewComment`, `updateReviewComment`, `deleteReviewComment` (each with activity logging on success; no activity on read).
- All mutations are exposed via the daemon HTTP routes AND the daemon-side MCP path; both call into this module.

### Step 7 — Config wiring (`packages/config/src/index.ts`)

Concrete edits, by line range:

- **L41-50** (`HookEventSchema`): append `"workspace.requestReview"` to the enum.
- **L65-68** (`HookConfigSchema.transform`): change the blocking-default array to `["workspace.setup", "workspace.teardown", "workspace.requestReview"]`.
- **L133-140** (`repoDefaults` inline object): add `requestReviewHookIds: z.array(z.string()).default([])`.
- **L140** (the `.default({...})` argument): add `requestReviewHookIds: []`.
- **L169-176** (`.superRefine` body): add `validateHookReferences(context, hooksById, config.repoDefaults.requestReviewHookIds, "workspace.requestReview", ["repoDefaults", "requestReviewHookIds"])`.

Add unit tests (in `packages/config/src/index.test.ts`) asserting:
- An authored `workspace.requestReview` hook without an explicit `blocking` resolves to `blocking: true`.
- `requestReviewHookIds` referencing a non-`workspace.requestReview` hook surfaces a validation error.
- Loading a config without the new field still parses (defaults to `[]`).

### Step 7b — Extend HookEvent consumers (operations diagnostics + Settings UI)

Two non-switch consumers of the hook-event list enumerate events as literal arrays. Both must learn about the new variant or the feature is unusable in the cockpit:

1. **`packages/operations/src/helpers.ts:392-415` (`listHookDiagnostics`)** — extend the `events` array (L392-397) with `"workspace.requestReview"`. Extend the ternary chain (L399-406) so the new event picks `input.requestReviewHookIds`. Thread `requestReviewHookIds: string[]` through the helper's input type. Update the callsite in `packages/operations/src/index.ts` (the existing `listHookDiagnostics` invocation — search for it; it's the only caller) to pass `requestReviewHookIds: repo.requestReviewHookIds`. The diagnostics endpoint (`/api/repos/:id/hook-diagnostics`) and the cockpit repo-settings hook diagnostics panel (`apps/web/src/routes/repo-settings.tsx`) will then include validation/health state for `workspace.requestReview` hooks.

2. **`apps/web/src/structured-config.tsx:22-30` and L61-70** — add `"workspace.requestReview"` to the HookConfig event TS union (L22-30) and to the `HOOK_EVENTS` runtime array (L61-70). Also extend the `ConfigResponse.config.repoDefaults` type (L53) to include `requestReviewHookIds: string[]` (it already silently lags behind `appHookIds`/`actionHookIds`; we add `requestReviewHookIds` to be consistent for the new event, even if the existing structured-config repo-defaults editor doesn't render it yet — type accuracy matters for the power-user escape hatch).

Tests added:
- `packages/operations/src/index.test.ts` (or a colocated helpers test): assert `listHookDiagnostics` includes a `workspace.requestReview` hook's diagnostic when authored.
- `apps/web/src/structured-config.test.ts` (if present) or a colocated component test: assert the event dropdown includes `workspace.requestReview`.

### Step 8 — Daemon routes (`apps/daemon/src/review-routes.ts` — NEW)

Routes listed in "Implementation approach § 6". Each:
- Validates input with zod.
- Calls the operations service.
- Returns JSON with consistent error shape (`{ error: { code, message } }`).
- 409 on `updated_at` conflict (PATCH/DELETE).
- POST `review-comments` ignores any `author` field in the request body and stamps `'operator'`.
- Mounts via the existing daemon router-registration pattern.

### Step 9 — MCP tools (`packages/mcp/src/index.ts` + `apps/daemon/src/daemon-mcp-tool.ts`)

- Register tool definitions: `list_review_comments` (read-only), `add_review_comment`, `update_review_comment`, `delete_review_comment` (destructive), `request_review` (daemon-mediated).
- Input schemas:
  - `list_review_comments`: `{ workspaceId, status?, includeDeleted? }`.
  - `add_review_comment`: `{ workspaceId, body, filePath?, lineStart?, lineEnd?, side? }` — **no `author` field**. Schema validation rejects extra keys via `.strict()` or `.passthrough(false)` equivalent.
  - `update_review_comment`: `{ id, body?, status?, ifUpdatedAtMatches }`.
  - `delete_review_comment`: `{ id, ifUpdatedAtMatches }`.
  - `request_review`: `{ workspaceId }`.
- Daemon-side `callDaemonMcpTool()`:
  - Stamps `author = 'agent:<runtimeId>'` from the request context (fallback `'agent:unknown'`).
  - On conflict, returns `{ error: 'conflict', latest: { ... } }` so the agent can re-read and retry.
  - Delegates to the same operations service used by HTTP routes.

### Step 10 — Cockpit UI (`apps/web/src/`)

- Add a `Review` tab between `Diff` and any other PR-related tabs.
- `RequestReviewPanel.tsx`: button + status (idle/loading/error/no-hook/empty/success) + suggestion list rendered by `kind`. On mount, fetch latest suggestion run for hydration. Debounce repeated clicks while a request is in-flight.
- `ReviewCommentsTab.tsx`: composer + list. Composer body textarea + optional file selector populated from `WorkspaceDiff` + optional line range. Resolve/edit/delete actions inline. Edit/delete carry the comment's last-read `updatedAt` as `ifUpdatedAtMatches`. On 409, refresh the comment and show a "this comment was edited elsewhere" banner.
- Disabled state when no hook configured — tooltip explains where to declare `workspace.requestReview`.
- Comment bodies render as plain text (`textContent` / React's safe text rendering). Never `dangerouslySetInnerHTML`.

### Step 11 — Domain language

Code identifiers and API fields use the terms from `specs/A-shared-definitions.md`: Workspace, Repository, Hook, Activity event, Operation, Provider. UI copy uses "Review", "Suggestion", "Comment".

## QA/Test Strategy

### Layer evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | **Required** | Contracts schema validation; DB accessors (incl. conflict semantics); operations service (request-review flow + comment CRUD); hook output parser; MCP tool dispatch (in-process + daemon-mediated branches); config wiring (blocking default + validate references). |
| E2E (Playwright) | **Required** | Operator-flow: register repo with a request-review hook (absolute-path script fixture), create workspace, open inspector, click Request review, see suggestions, add/edit/resolve a comment with concurrency-token round-trip, verify persistence after reload. |

No "integration" layer per repo convention. Daemon HTTP routes are exercised end-to-end via Playwright + via daemon-route Vitest specs (see `scheduled-agent-routes.test.ts` pattern).

### New tests to add

**Contracts (`packages/contracts/src/review.test.ts` — NEW; existing `index.test.ts` may not exist or may grow past 800 lines, so colocate with `review.ts`):**
- `ReviewSuggestionsOutputSchema` accepts an empty payload, accepts a fully-specified payload, rejects suggestions over the max-50 limit, rejects unknown `kind` values, rejects suggestions where `label` exceeds 200 chars.
- `ReviewCommentSchema` rejects `lineEnd < lineStart`; rejects negative line numbers; rejects `body` empty or over 8000 chars; rejects `lineStart` without `filePath`; accepts a PR-level comment with all anchors null.

**Config (`packages/config/src/index.test.ts` — extend):**
- `HookEventSchema` accepts `workspace.requestReview`.
- An authored `workspace.requestReview` hook without `blocking` resolves to `blocking: true`.
- `requestReviewHookIds` validation rejects references to hooks whose `event` is not `workspace.requestReview`.
- Loading a config without `requestReviewHookIds` defaults it to `[]`.

**DB (`packages/db/src/review-comments.test.ts`, `packages/db/src/review-suggestion-runs.test.ts` — NEW):**
- `insertReviewComment` → `listReviewComments` round-trip preserves all fields including null anchors.
- `updateReviewComment` updates `updated_at` strictly later than `created_at`.
- `updateReviewComment` with a stale `ifUpdatedAtMatches` returns `{ kind: 'conflict', latest }` and does NOT update the row.
- `softDeleteReviewComment` hides the row from default lists; visible with `includeDeleted: true`. Verify physical row still exists via raw SQL.
- `listReviewComments` excludes comments belonging to archived workspaces by default; includes them when `includeArchived: true`.
- Cascade: hard-deleting a workspace removes its comments and suggestion runs.
- Migration idempotency: applying the migration twice is a no-op. `schema_migrations` includes `(8, 'review-system', …)`.

**Hooks (`packages/hooks/src/index.test.ts` — extend):**
- `parseReviewSuggestionsOutput("")` returns `null`.
- `parseReviewSuggestionsOutput(validJson)` returns the parsed payload.
- `parseReviewSuggestionsOutput(invalidJson)` throws with a clear error.
- `parseReviewSuggestionsOutput(stdoutThatHitsTheSliceLimit)` produces a parse error that mentions truncation.

**Operations (`packages/operations/src/review-system.test.ts` — NEW):**
- `requestReviewForWorkspace`:
  - No hook configured → returns `{ kind: 'no-hook' }`, no rows written, no activity row.
  - Hook succeeds → writes one `review_suggestion_runs` row (status `succeeded`, parsed JSON in `output_json`), appends ONE `activity_events` row (type `hook.workspace.requestReview`).
  - Hook times out → writes a row with status `timed_out`, no parsed JSON, error mentions timeout, appends ONE activity row (type `hook.workspace.requestReview.failed`). Detected via runner rejection message.
  - Hook returns invalid JSON → writes status `failed`, no parsed JSON, error explains validation failure, ONE activity row (failed).
  - Hook returns empty stdout → writes status `succeeded` with `output_json` = JSON-encoded `{ suggestions: [], generatedAt: null, metadata: {} }` (or `NULL` — pick and assert).
- `addReviewComment`: persists; appends activity row. Force-`'operator'`-author path (HTTP) ignores caller-supplied author. Force-`'agent:<id>'`-author path (MCP) stamps the runtime id.
- `updateReviewComment` with stale token returns conflict; with fresh token updates; resolving appends `review.comment.resolved`.
- `deleteReviewComment` soft-deletes; idempotent (second call with same stale token returns conflict; with fresh token returns updated tombstone).
- Listing: `status: 'open'` excludes resolved and soft-deleted; `status: 'all'` excludes only soft-deleted; explicit `includeDeleted: true` includes them.

**Daemon (`apps/daemon/src/review-routes.test.ts` — NEW; follow `scheduled-agent-routes.test.ts` pattern):**
- `POST /api/workspaces/:id/review-requests`: 200 with parsed suggestions; 404 on unknown workspace; structured error code `no-hook` when no hook configured.
- `POST /api/workspaces/:id/review-comments`: 200 with persisted id; ignores caller `author` and stamps `'operator'`; 400 on missing body / invalid anchor; 404 on unknown workspace.
- `PATCH /api/review-comments/:id`: 200 on success; 409 on stale `ifUpdatedAtMatches`; 400 on attempting to edit a deleted comment.
- `DELETE /api/review-comments/:id`: 204 on success; 409 on stale token; second delete of an already-deleted comment returns 409 unless caller passes the latest `updated_at`.
- `GET /api/workspaces/:id/review-suggestions`: latest run or null when none.

**MCP (`packages/mcp/src/index.test.ts` — extend):**
- `list_review_comments` returns the same rows as the DB accessor.
- `add_review_comment` schema rejects a request that includes `author`.
- Mutating tools return `{ error: 'mutating_tool_requires_daemon' }` from the in-process path.
- Daemon-mediated `add_review_comment` stamps `author = 'agent:<runtime-id>'`.
- Daemon-mediated `update_review_comment` with stale token returns `{ error: 'conflict', latest }`.
- `request_review` returns `{ error: ... }` from the in-process path; daemon-mediated path calls through.

**Cockpit UI (`apps/web/src/RequestReviewPanel.test.ts`, `ReviewCommentsTab.test.ts` — NEW):**
- `RequestReviewPanel`: button disabled with tooltip when no hook configured; renders loading / error / no-hook / empty / success states; renders suggestions grouped by `kind`; debounces repeated clicks while in-flight.
- `ReviewCommentsTab`: composer requires a body; submitting POSTs to the route and prepends the new comment; resolved comments collapse by default; deleting removes the comment optimistically; 409 surfaces an in-place banner.
- XSS smoke: rendering a comment body with `<script>alert(1)</script>` produces no script execution and renders as literal text.

**E2E (`e2e/review-system.spec.ts` — NEW):**
- Fixture: at test setup, write a tiny POSIX shell script at `${testRoot}/tests/fixtures/hooks/request-review.sh` (`chmod +x`), then write a `citadel.config.json` with `hooks[].command = path.resolve(testRoot, "tests/fixtures/hooks/request-review.sh")` and `hooks[].cwd = testRoot` (absolute path — required by `HookConfigSchema.cwd` refinement). The script emits a hard-coded `ReviewSuggestionsOutput`.
- Create a workspace, navigate to its inspector, click Request review, assert the suggestions render. Add a PR-level comment, reload, assert the comment persists. Resolve the comment, assert it collapses. Verify the activity feed shows `hook.workspace.requestReview` (singular — no duplicate `review.requested` row) and `review.comment.added`.

### Existing tests to update

- `apps/web/src/inspector.test.ts` — extend if the inspector tab list is asserted there; otherwise no change.
- `apps/daemon/src/mcp-routes.test.ts` (if present) — extend the tool inventory assertion to include the new tools.
- `scripts/dev/smoke.ts` — extend with a round-trip probe: POST a comment, GET the list (expect length 1), DELETE (expect 204), GET again (expect length 0).

### Assertions to add/change/tighten

- DB accessor tests assert `updated_at >= created_at` and that a no-op update still bumps `updated_at` (or doesn't — pick the contract and assert; preferred: bumps).
- Soft-delete tests assert physical row still exists in the table after `softDelete`.
- Conflict tests assert the row was NOT mutated when the token was stale.
- Activity-row tests assert exactly ONE row per logical event (no duplicate `review.requested` + `hook.workspace.requestReview`).
- E2E asserts the activity feed event-type spelling matches the canonical names.

### Failure modes / edge cases / regression risks

- **Hook output too large.** `runCommandHookForDiagnostics` caps stdout at 64KB via `.slice(-65536)` — if a hook emits banner text + JSON at the end, slice fits; but a hook that emits >64KB of JSON gets a corrupt leading-edge parse failure. Mitigation: parser surfaces a clear truncation error. Test covers this.
- **Hook deadlock or runaway.** Timeout cleanly rejects via SIGTERM. Operations service catches and writes `timed_out`. Test covers this.
- **Workspace archived (not deleted) while a comment exists.** `listReviewComments` filters archived by default — comment is hidden from MCP and UI but the row stays for resurrection-after-unarchive. Test covers both visibility states.
- **Workspace hard-deleted while a request-review is in flight.** FK cascade on `workspaces(id)` removes related rows; if the service is mid-`INSERT`, the constraint fails — operations service catches and logs without crashing. Test by stubbing workspace removal between payload build and insert.
- **Comment body XSS.** All bodies render as plain text. Tested.
- **Concurrent comment edits.** `ifUpdatedAtMatches` (optimistic concurrency) protects mutations from stale-read clobbering. 409 returned; agent must re-read and retry. Tested at every layer.
- **Hook returning invalid `url` in a suggestion.** Schema rejects; the whole payload fails parse; run records `failed`; no partial suggestions stored. Tested.
- **Activity log volume.** Every comment mutation appends a row. Only successes + failures, not reads. No retention policy in v1 — documented in the spec. Follow-up: bulk-resolve / archive on merged PRs.
- **MCP author spoofing.** Schema-rejected at request-time. Tested.
- **Concurrent in-flight `request_review` runs.** Two callers (operator + agent) both spawn hooks; both rows are stored. UI hydrates from `latestReviewSuggestionRun` (singular). Documented behavior.
- **Diff truncation.** Hook payload's `diff.files` is paths only; total payload bounded. Full diff content remains available via `/api/workspaces/:id/diff` for hooks that need it.

### Adversarial analysis

- **How could this fail in production?** Most likely: a buggy `workspace.requestReview` hook returns malformed JSON or hangs. Both are bounded (timeout + JSON parse). Second most likely: agent + operator concurrent edits — now blocked by optimistic concurrency.
- **What user actions trigger unexpected behavior?** Clicking Request review while a previous run is in flight — debounce + per-call rows. Editing a comment after an agent has edited it — 409 with explicit re-read banner.
- **What existing behavior could break?** Existing hook events are unchanged. `repoDefaults` gains a defaulted optional field — existing config files load unchanged. `runCommandHookForDiagnostics` is unchanged. The new variant is silently filtered by event-equality checks in `hooks-runner.ts:41`, which is the desired behavior (request-review hooks should not fire on setup events). Two literal enumerations of hook events DO need updating — `listHookDiagnostics` (`packages/operations/src/helpers.ts:392`) and the Settings UI hook dropdown (`apps/web/src/structured-config.tsx:61`). Both are explicitly addressed in Step 7b; without that step the new hook can be authored only by hand-editing JSON and its health is invisible to the diagnostics panel.
- **Which tests credibly catch failures?** Operations-service tests cover hook misbehavior. Migration idempotency test catches double-apply. Config tests cover defaulted-field upgrade and validation-references.
- **What gaps remain?** v1 has no full-screen diff-anchored review surface; no comment notifications; no permission model on edit/delete (anyone with daemon access can edit any comment via HTTP — MCP path stamps the author); no rate limiting on Request review; no retention policy. Documented as follow-ups.

## Tests

Test files to create or modify (TDD order — write before the corresponding implementation step):

1. `packages/contracts/src/review.test.ts` — NEW (schema validation).
2. `packages/config/src/index.test.ts` — extend (event + blocking default + validation references + defaulted-field).
3. `packages/db/src/review-comments.test.ts` — NEW.
4. `packages/db/src/review-suggestion-runs.test.ts` — NEW.
5. `packages/db/src/migrate.test.ts` — extend (idempotency + version 8 row).
6. `packages/hooks/src/index.test.ts` — extend (parser + truncation).
7. `packages/operations/src/review-system.test.ts` — NEW.
8. `packages/mcp/src/index.test.ts` — extend (tool inventory + author-spoof + conflict).
9. `apps/daemon/src/review-routes.test.ts` — NEW.
10. `apps/web/src/RequestReviewPanel.test.ts` — NEW.
11. `apps/web/src/ReviewCommentsTab.test.ts` — NEW.
12. `e2e/review-system.spec.ts` — NEW (fixture absolute-path script under `tests/fixtures/hooks/request-review.sh`).

## Schema or contract generation

Citadel does not have a code-generation step for contracts or schemas — `packages/contracts` is hand-written TypeScript with zod. After contract additions, run `pnpm build` (covered by `make check`) so project-reference consumers re-typecheck. No schema generator command beyond `make check`.

## Verification

Before opening the PR, the implementation agent must run and pass:

- `make check` — full local gate: arch boundaries, file size (verify `packages/contracts/src/index.ts` stays ≤800 lines; the new `review.ts` is well under), typecheck, biome lint, vitest, coverage (≥90% on core/backend/shared), dep policy, build.
- `make smoke` — required (new daemon HTTP surface + new MCP tools). Extend `scripts/dev/smoke.ts` to probe `GET /api/mcp/status` (assert new tool names appear) and to do a round-trip on `review-comments` against a seeded workspace: POST → GET (expect length 1) → DELETE (expect 204) → GET (expect length 0).
- `make e2e` — Playwright happy-path including the new `e2e/review-system.spec.ts`.
- `make performance` — not required (no startup/hot-path changes).
