Activate the /implement-task skill first.

# Plan: Diff Viewer And Internal Review Threads

## Acceptance Criteria

User-stated topic:

- [ ] **Diff viewer**
- [ ] Show staged AND unstaged changes vs main: list of committed-vs-main files + commits, plus uncommitted/unstaged
- [ ] Fullscreen, GitHub-style side-by-side per-file diff; inspiration: superset.sh implementation

Agreed scope from the grilling session:

- [ ] Start from current `origin/main`; discard the stale prototype branch implementation.
- [ ] Use `@pierre/diffs` / diffs.com as the primary renderer if dependency review passes, following the Superset metadata-first plus lazy per-file content approach.
- [ ] Show a continuous GitHub-style review scroll with separate `Committed vs base`, `Staged`, and `Unstaged` sections mirrored in a file-outline sidebar.
- [ ] Resolve "vs main" through the selected worktree checkout `baseBranch`, preferring `origin/<baseBranch>` when present and falling back to local base refs. Do not fetch during diff load.
- [ ] PR creation is in scope. If no PR exists for the selected checkout, the review screen shows a create-PR action; internal comments require an existing PR-backed review scope.
- [ ] PR creation uses GitHub/`gh` only for the first implementation, never creates draft PRs, respects GitHub PR templates, does not request reviewers or labels, and never stages or commits dirty work.
- [ ] PR title comes from the linked issue/Jira title when available; otherwise use the Workspace title/name. The PR body respects repo templates; if there is no template, generate a concise default body. Do not add a PR-body edit modal.
- [ ] The diff viewer still shows full local state immediately after a PR exists, including committed, staged, and unstaged changes, regardless of local dirtiness.
- [ ] Add internal review threads with replies, line/range comments, and file-level comments. Threads are PR-backed review-scope scoped, remain internal forever, can be resolved/reopened, and resolved threads remain expandable.
- [ ] Agents can list, create, reply to, resolve, and reopen internal review threads through MCP. Do not expose diff content through MCP in this version.
- [ ] Agents can mark a thread resolved with "fixed this"; there is no separate addressed state.
- [ ] Agents can create internal review threads through MCP using file/line anchors from their local code context. Server validates anchors and derives canonical context when possible.
- [ ] Store `authorKind` so user and agent comments are visually distinct.
- [ ] Only `open + current` internal threads block review readiness. Resolved threads and outdated threads do not block readiness.
- [ ] Keep review data in first-class SQLite tables with retention: merged PR review data is hard-deleted after fresh merged observation; closed-unmerged PR data is retained briefly for reopen, then pruned.

## Context And Problem Statement

This branch has been reset to current `origin/main` so implementation can start fresh. The earlier fullscreen diff prototype is intentionally abandoned. `origin/main` now includes the structured workspace model: Workspaces contain Worktree checkouts, each checkout represents one branch and intended PR, and checkout gates consume durable PR/check facts plus review artifacts.

The desired feature is a checkout-level Human Review surface. The operator should inspect the full local checkout state before GitHub review, leave internal comments, and let agents consume and update those comments through MCP. Internal comments stay private Citadel state forever. Future public GitHub comments are a distinct provider/public comment kind, not an export path for internal comments.

Research from the grilling session confirmed that Superset uses `@pierre/diffs/react` with `CodeView`, lazy old/new content, `parseDiffFromFile`, worker-backed Shiki, sticky headers, annotations, viewed state, and review-like affordances. Citadel should follow that renderer shape instead of building a custom side-by-side table.

## Spec Alignment

Applicable specs:

- `specs/A-shared-definitions.md` for Repository, Workspace, Worktree checkout, Execution target, Provider fact, Review artifact, Implementation gate, Agent tool authority, Operation, Readiness, and MCP product language.
- `specs/B.2-ade-cockpit.md` for the cockpit, checkout detail, inspector Diff tab, fullscreen review entry, dense UI, keyboard behavior, and cockpit overlays.
- `specs/B.4-git-pr-ci-diff.md` for Git status, PR identity, checkout gates, review artifacts, stacked PRs, diff, and Human Review behavior.
- `specs/B.7-operations-activity-mcp.md` for Operations, MCP tools, daemon-mediated side effects, and agent tool authority.
- `specs/B.8-ui-performance-quality.md` for UI density, desktop/mobile screenshot review, performance smoke, and test isolation.

Spec updates are required first. Current B.4 still says Human Review remains scoped to the selected workspace, while current main now models PR/gate state through Worktree checkouts. The agreed design should become: review entry is reached from workspace context, but the review surface is scoped to a selected Worktree checkout and its PR-backed review scope.

Expected spec changes:

- In `specs/B.4-git-pr-ci-diff.md`, add behavior for checkout-scoped fullscreen Human Review, `@pierre/diffs`-style continuous sections, committed-vs-base plus staged plus unstaged local diff, create-PR entry, internal comments, file-level comments, thread lifecycle, viewed state, retention, local-vs-PR divergence warnings, and local/private vs future provider/public comments.
- In `specs/B.4-git-pr-ci-diff.md`, clarify that open/current internal review threads contribute to the selected checkout gate as `review_blocked`, below conflicts/check failures/stale provider facts, and then roll up into Workspace readiness.
- In `specs/B.7-operations-activity-mcp.md`, add checkout-scoped MCP tools for PR creation/push and internal review thread operations, explicitly excluding diff-content exposure and requiring server-held context or agent tool authority for side-effectful calls.
- In `specs/B.2-ade-cockpit.md`, add the dense continuous review route requirement and specify that the route is a cockpit overlay preserving the mounted cockpit/terminal state.
- In `specs/B.8-ui-performance-quality.md`, require desktop/mobile screenshot review and performance smoke coverage for large diff rendering.

## Implementation Approach

Use first-class contracts and SQLite tables, but align all product entry points with current main's checkout model.

Primary target model:

- Review APIs are checkout-scoped. The UI enters through a selected Worktree checkout, and daemon routes validate `checkoutId` before reading git or review data.
- A review scope is PR-backed. Before PR creation, the route can show local diff metadata and a create-PR action, but it cannot create internal comments.
- The review scope stores provider/repository/PR identity so comments are tied to the PR conceptually, while APIs still enter through `checkoutId` because that is how current Citadel models multi-repo workspaces.
- Existing `checkout_review_artifacts` remain dedicated to `review-pr` action artifacts. Internal operator/agent comments use separate review-thread tables and should not overload artifact rows.
- Existing `/api/workspaces/:workspaceId/pr-diff` is either extended as a compatibility wrapper or replaced by the new checkout review diff service. Do not build duplicate, inconsistent PR diff semantics.

Backend diff shape follows Superset:

- `GET /api/checkouts/:checkoutId/review-diff` returns metadata only: checkout summary, base resolution, PR/review scope summary, section/file metadata, file identities, commit list, truncation/stale warnings, viewed/thread counts, and local-vs-PR divergence warnings.
- `GET /api/checkouts/:checkoutId/review-diff/file?fileId=...` returns lazy old/new content for one opaque file identity and bucket, plus binary/deleted/rename metadata. The web passes this into `@pierre/diffs` `parseDiffFromFile` / `CodeView`.
- The lazy file endpoint must never trust arbitrary path input. Metadata returns opaque file IDs. Content requests resolve only those IDs against freshly generated diff metadata, use `git --` path arguments or object reads, reject symlink/path traversal escapes for worktree reads, and apply the existing repository-root containment guard.
- Sections are `against-base`, `staged`, and `unstaged` internally. UI labels are `Committed vs base`, `Staged`, and `Unstaged`.
- Base resolution uses checkout `baseBranch`, prefers `origin/<baseBranch>`, falls back to `<baseBranch>`, records base tip SHA, merge-base SHA, and whether the base is missing or not recently refreshed. It does not fetch.
- `against-base` compares merge-base to local `HEAD`, not PR head and not current base tip. The commit list is `merge-base..HEAD`.
- `staged` compares `HEAD` to the index. `unstaged` compares index to worktree. Untracked files compare empty old content to worktree content.
- If a path appears in multiple buckets, each bucket gets its own file identity so comments and viewed state do not collide.
- Diff identities include bucket, path/oldPath, status, mode, side, merge-base/head SHA for committed files, index/blob identity for staged files, and worktree content hash for unstaged/untracked files. Anchor validation also stores selected line text or a hunk hash; an anchor is current only when coordinates and content identity still match.

PR creation and push:

- Add provider-neutral contracts, with GitHub/`gh` as the only implementation now.
- Add checkout-scoped create-PR and push-branch UI actions, HTTP routes, and MCP tools.
- Treat create-PR and push-branch as side-effectful Actions backed by Operations. The route/MCP call may wait for the short operation and return the final result, but progress/log/error state should be durable and visible through the existing Operation model.
- `create_pull_request` first checks for an existing PR for the checkout's repository/head/base/open state. If one exists, upsert/return the review scope, do not push, and warn if local `HEAD` is ahead of the PR head.
- If no PR exists, block detached `HEAD`, block zero commits ahead of base, warn on dirty/staged changes, push committed state to the repo `defaultRemote` using argv-based git execution, then create a non-draft PR.
- Dirty/staged warnings list the excluded buckets and paths. They are warnings, not an acknowledgement gate.
- `gh pr create` is the primary path. If GraphQL-specific rate limiting blocks it, fall back to REST via `gh api /repos/{owner}/{repo}/pulls` with `draft:false`.
- After any `gh pr create` failure, repeat existing-PR lookup before REST fallback so a partial success cannot create a duplicate PR.
- Existing PR lookup uses provider repo identity, head owner/repo/branch, base branch, and open state. Branch-only lookup is not sufficient.
- First version supports the repo configured `defaultRemote` only. If that remote cannot be resolved to a writable GitHub owner/repo, PR creation/push fails clearly. Fork-specific selection is future work.
- Provider degradation is explicit: missing `gh`, unauthenticated `gh`, unparseable remotes, unsupported non-GitHub remotes, active cooldowns, secondary rate limits, permission failures, and non-FF push failures return typed warnings/errors that keep the diff visible and disable only provider-backed actions.
- Git and `gh` commands must run through argv APIs, never shell string interpolation. Validate branch/ref names and use `--` pathspec boundaries for all path arguments. Never force-push.

Review persistence:

- Add `internal_review_scopes`, `internal_review_threads`, `internal_review_thread_replies`, and `internal_review_viewed_files`.
- `internal_review_scopes` stores workspace id, checkout id, repo id, provider identity, provider repository key, external PR id/number/url, base ref, head ref, head SHA, provider state, terminal observation timestamps, and created/updated timestamps.
- Scope uniqueness should prefer stable provider PR id when available and fall back to provider repository key plus PR number. Add checkout indexes so the UI can resolve the selected checkout quickly.
- Threads store `kind` (`internal` now, future `external`/provider comments read-only), `status` (`open` or `resolved`), `anchor_state` (`current` or `outdated`), `anchor_kind` (`line` or `file`), bucket, path/oldPath, side, start/end line, relevant git identity, author kind, nullable provider ids, and timestamps.
- Replies store body, author kind, nullable provider ids, and timestamps. Creating a thread inserts the thread and first reply in one transaction.
- Viewed state is keyed by review scope plus bucket/path/oldPath/diff identity, not PR head alone.
- Retention runs after successful fresh provider observations and on daemon startup/reconcile. Merged scopes are hard-deleted immediately only after a fresh successful `merged` observation. Closed-unmerged scopes older than 7 days are hard-deleted after fresh closed observations. Unavailable, stale, rate-limited, or misconfigured provider states never delete data. Retention deletes only SQLite review rows, never worktrees.

Thread anchoring:

- Line/range comments and file comments are supported from the first version.
- MCP-created anchors do not need copied context text. The server validates bucket/path/side/line/range against the current diff and derives canonical context when possible.
- Revalidation is exact in the first version. If the exact line/range or file identity no longer validates, mark `anchor_state=outdated`; do not silently relocate.
- Comments on staged/unstaged local changes are allowed after the PR-backed review scope exists and may become outdated as local content changes.
- Resolved threads remain expandable and can be reopened by the user or an authorized agent.

Frontend:

- Add a checkout review route under the existing pathless cockpit layout so `Cockpit` and terminal panes remain mounted.
- Replace the abandoned selected-file prototype with a continuous `CodeView` route powered by `@pierre/diffs/react`.
- The first screen is the review surface, not a landing page. It has a compact header, section/file outline sidebar, continuous diff stream, and collapsible right review panel.
- Commit list appears in the sidebar/header, not inside the code stream.
- If no PR exists, show the full local diff and a create-PR action, but do not show comment composers until a review scope exists.
- If the cockpit is focused on Home with exactly one checkout, the inspector can deep-link to that checkout review. If multiple checkouts exist, show a compact checkout picker/list rather than guessing.
- After a PR exists, load internal threads immediately regardless of local dirtiness.
- Default thread filter is `open + current`; allow toggles for resolved, outdated, and all. Resolved threads remain expandable and reopenable.
- Inline composer appears from line/range selection. File-level composer appears from file headers, including binary files.
- Use plain textarea plus sanitized markdown rendering, no toolbar. Raw HTML is disabled, unsafe links are sanitized, and comment bodies are redacted from broad activity/error logs.
- Agent comments are visually distinct with a subtle label/icon using `authorKind`.
- Show compact warnings for missing/stale base, dirty state not included in PR creation, local `HEAD` ahead of PR head, PR head ahead of local, branch mismatch, unsupported provider, and provider cooldown.

Readiness:

- Open/current internal review threads contribute to the selected checkout gate as `review_blocked`, below conflicts, check failures, and stale provider facts.
- Workspace readiness aggregates checkout gate state. The review-thread blocker should not hide higher-priority blockers.
- Resolved threads and outdated threads never block readiness.
- Resolving all current open internal threads only removes that blocker; it does not auto-complete review or create a `review-pr` artifact.
- Readiness must revalidate anchors, or read from a current diff snapshot that revalidated them, before using `open + current` counts. Thread listing also revalidates so stale anchors cannot keep blocking after local edits.

Architecture boundaries:

- `apps/web` imports only `@citadel/contracts`, existing web utilities, React/TanStack code, and `@pierre/diffs`; it must not import daemon, db, provider, MCP, or git helpers.
- `apps/daemon` owns HTTP routes, git diff reads, provider calls, DB calls, operation wiring, MCP daemon dispatch, and review retention.
- `packages/contracts` owns shared Zod DTOs only.
- `packages/db` owns SQLite schema/store helpers only and does not import daemon/provider/web code.
- `packages/providers` owns GitHub/`gh` helpers and does not import daemon/web code.
- `packages/mcp` exposes normalized tool definitions and snapshot fallbacks; daemon-dispatched handlers perform side effects and authority checks. MCP does not expose diff content.
- `packages/operations` owns operation-backed actions when existing service boundaries need durable progress/logs. Keep additions narrow.
- `packages/core` and `apps/cli` remain untouched unless the implementation discovers an existing readiness helper that belongs in core; any such move must preserve core purity.

## Alternatives Considered

- Keep the custom `unifiedToSideBySide` viewer. Rejected because `@pierre/diffs` already provides the Superset-style flow the user explicitly wants.
- Keep review APIs workspace-scoped. Rejected because current main models multi-repo work through Worktree checkouts, and one Workspace can have multiple PRs.
- Store internal comments in `checkout_review_artifacts`. Rejected because artifacts represent `review-pr` action results, while comments are threaded operator/agent discussion.
- Allow internal comments before PR creation. Rejected by user. The review route may show diff and create-PR action before PR exists, but comments begin after a PR-backed review scope exists.
- Export internal comments to GitHub later. Rejected by user. Internal comments remain internal forever; future public GitHub comments are distinct provider/public comments.
- Use context matching to relocate moved anchors. Rejected for the first version because it can silently attach feedback to the wrong code. Exact validation plus outdated state is safer.

## Implementation Steps

### Branch Hygiene

- Start from the reset branch based on current `origin/main`.
- Treat any old branch prototype files as deleted. Do not resurrect `workspace-diff-view` route/components except by manually extracting test ideas.
- Re-check `git status` before implementation and avoid touching unrelated dirty files if the implementation session creates any.

### Spec Updates

- Update `specs/B.4-git-pr-ci-diff.md`, `specs/B.7-operations-activity-mcp.md`, `specs/B.2-ade-cockpit.md`, and `specs/B.8-ui-performance-quality.md` as described in Spec Alignment.
- Keep terminology aligned with `specs/A-shared-definitions.md`: Repository, Workspace, Worktree checkout, Provider fact, Review artifact, Implementation gate, Operation, Readiness, Agent tool authority.

### Dependencies

- Add `@pierre/diffs` to the web package dependency set and update `pnpm-lock.yaml` using pnpm only.
- Record dependency justification, selected version, license result, and lifecycle script review result. If the package or transitive dependencies include install scripts, document the risk and reject/mitigate before implementation proceeds.
- Wire any required worker/Shiki setup in `apps/web` following the Superset implementation pattern.

### Contracts

- Add checkout review diff metadata/content schemas in `packages/contracts`.
- Add internal review scope/thread/reply/viewed-state schemas.
- Add checkout-scoped PR creation/push request and response schemas, including typed warnings/errors.
- Add review-thread MCP input schemas that can target by `checkoutId` or `reviewScopeId`, with `checkoutId` as the primary UI/API entry.
- Export all new types from the public contracts entrypoint and keep web/daemon boundaries contract-only.

### Database

- Add the next schema migration after reconciling with current `origin/main`. As of this precheck, `CURRENT_SCHEMA_VERSION = 19`; this plan expects v20 named `internal-review-threads`. Re-check immediately before editing and bump if main has advanced.
- Create `internal_review_scopes`, `internal_review_threads`, `internal_review_thread_replies`, and `internal_review_viewed_files`.
- Add indexes for scope lookup by checkout, scope lookup by provider/repository/PR identity, threads by scope/status/anchor state, threads by scope/kind, replies by thread, and viewed files by scope.
- Add DB helper modules instead of growing `packages/db/src/index.ts` past the file-size gate. Apply the same split rule to daemon review routes/services and web review components: no non-generated source file should approach the 800-line limit.
- Add retention helpers for merged/closed scopes and orphan pruning.

Migration strategy:

- `CREATE TABLE IF NOT EXISTS internal_review_scopes`: additive. Include FKs to workspaces/checkouts/repos where current schema supports them, `CHECK` constraints for provider state values where practical, and unique indexes for provider PR identity.
- `CREATE TABLE IF NOT EXISTS internal_review_threads`: additive. Include `ON DELETE CASCADE` to `internal_review_scopes`, `CHECK` constraints for `kind`, `status`, `anchor_state`, `anchor_kind`, `bucket`, and `author_kind`.
- `CREATE TABLE IF NOT EXISTS internal_review_thread_replies`: additive. Include `ON DELETE CASCADE` to `internal_review_threads` and `CHECK` constraints for `author_kind`.
- `CREATE TABLE IF NOT EXISTS internal_review_viewed_files`: additive. Include `ON DELETE CASCADE` to `internal_review_scopes` and a unique key over review scope plus bucket/path/oldPath/diff identity.
- `CREATE INDEX IF NOT EXISTS ...`: additive.
- `INSERT OR IGNORE INTO schema_migrations(version, name, applied_at) VALUES (20, 'internal-review-threads', datetime('now'))`, unless main has advanced and a higher version is required.
- No destructive schema operations, no renames, no data backfill, no FK removal. `PRAGMA foreign_keys = ON;` remains unchanged.
- Existing operator databases get empty internal review tables on startup. Existing PR/check/review-artifact data remains untouched.

### Provider And PR Actions

- Extend `packages/providers` with GitHub/`gh` helpers for existing PR lookup, branch push, PR creation, PR template discovery, remote owner/repo resolution, REST fallback, and typed provider degradation.
- Reuse existing cooldown classification where it exists. Add only the minimum extra classification needed to detect GraphQL-specific `gh pr create` failure and attempt REST fallback safely.
- Add operation-backed daemon routes for checkout push and create PR.
- Upsert checkout intended PR bindings, checkout PR facts where appropriate, and internal review scopes from existing PR detection/refresh and create PR.
- Add UI actions in the review route and MCP actions in `packages/mcp`/daemon dispatch.

### Diff Backend

- Add a checkout review diff service in `apps/daemon` that produces metadata sections and lazy file content from git.
- Resolve base refs without fetching, record merge-base/base-tip/head SHA, and surface stale/missing warnings.
- Because diff load does not fetch, label base freshness as "not refreshed" unless the daemon has a known recent fetch timestamp for the remote-tracking ref. Do not claim true remote staleness without a fetch.
- Compute `against-base`, `staged`, and `unstaged` identities independently.
- Support binary, deleted, untracked, renamed, copied, conflicted, submodule, symlink, mode-only, LFS pointer, and binary rename files with explicit metadata and placeholders/commentability rules.
- Cap metadata and content payloads with clear truncation flags. Initial thresholds: 1,000 files per section metadata cap, 2 MiB per side per text file content cap, binary files content omitted. UI shows an explicit too-large/truncated state and still allows file-level comments.
- Revalidate thread anchors on diff metadata/content reads and persist current/outdated transitions.
- Keep or adapt existing `/api/workspaces/:workspaceId/pr-diff` tests so legacy behavior either delegates to the new service or has a documented compatibility path.

### Review Threads API

- Add HTTP routes for listing scopes, listing threads, creating threads, replying, resolving, reopening, and marking files viewed.
- Ensure create-thread validates current anchor coordinates and stores canonical context where derivable.
- Ensure all mutating routes update timestamps and emit enough activity for debugging without exposing private comment bodies broadly. Activity/errors may include IDs/counts/state changes, not comment bodies or selected diff snippets.
- Render comment markdown through the same sanitized markdown policy in UI tests; raw HTML and `javascript:` links must not execute.
- Keep future external/provider comments represented by `kind` and nullable provider fields, but only implement internal mutable comments now. Future external comments are read-only in Citadel unless/until a public provider-comment feature is built.

### MCP

- Add tools: `list_review_scopes`, `create_pull_request`, `push_branch`, `list_review_threads`, `create_review_thread`, `reply_review_thread`, `resolve_review_thread`, and `reopen_review_thread`.
- Tool targeting uses `checkoutId` first and may accept `reviewScopeId` after scope creation. CWD-based resolution may be supported through existing checkout context resolution.
- `list_review_threads` defaults to `open + current`.
- Side-effectful MCP tools must be daemon-dispatched and compatible with `agent_tool_authorities`. Body-supplied actor/ownership fields are ignored or rejected on mismatch.
- Managed agent sessions should only mutate review threads or trigger push/create-PR when their server-held session context or authority record allows the target checkout/tool.
- Do not add any tool that returns diff content in this version.

### Frontend Review Route

- Add a route under the cockpit layout, for example `/workspaces/$workspaceId/checkouts/$checkoutId/review`, and register it without unmounting `Cockpit`.
- Add a compact link/action from the Inspector `Diff` tab to the review route. If multiple checkouts exist, render checkout choices rather than assuming one.
- Build a dense continuous review surface with section sidebar, sticky file headers, viewed checkboxes, file-level comment buttons, inline line/range comment composers, and a collapsible review panel.
- Show create-PR and push actions with warnings and clear disabled states.
- Show local-vs-PR divergence and base resolution warnings compactly.
- Keep the layout responsive with stable dimensions for sidebars, toolbars, counters, and file rows so comments/loading states do not shift layout.
- Verify desktop and mobile screenshots before handoff.

### Readiness And Cockpit Integration

- Add checkout gate/readiness input for open/current internal review threads below conflicts, check failures, and stale provider facts.
- Show unresolved internal comment count in checkout PR/review context where appropriate.
- Ensure resolved/outdated thread counts do not block readiness.
- Ensure the existing `review-pr` artifact gate remains separate: internal comment resolution does not fabricate or update a review artifact.

## QA/Test Strategy

### Layer Evaluation

| Layer | Verdict | Details |
|-------|---------|---------|
| Unit (Vitest) | Required | Covers contracts, DB migration/helpers, provider command behavior, diff metadata/content generation, anchor validation, retention, readiness/gate integration, MCP handlers, and frontend review utilities/components. |
| E2E (Playwright) | Required | This changes the main operator review journey and daemon-served HTTP contracts consumed by the web app. Cover no-PR create action, existing-PR review route, comments, resolve/reopen, viewed state, and screenshot layout. |

### New Tests To Add

- `packages/contracts/src/index.test.ts` or focused contract tests: parse/reject checkout review diff, internal review scope, thread, reply, viewed state, PR creation, and push schemas.
- `packages/db/src/migration.test.ts`: v20 tables/indexes/migration row exist and migration is idempotent.
- `packages/db/src/internal-review-store.test.ts`: upsert scopes, create thread with first reply transactionally, reply, resolve, reopen, mark viewed, prune merged scopes only after fresh provider observation, prune closed scopes after 7 days, cascade SQLite rows only, and do not touch worktree cleanup policy.
- `packages/providers/src/index.test.ts` or a focused GitHub PR actions test file: existing PR idempotency by repo/head/base/open state, detached head/zero-ahead blocking inputs, dirty warning with excluded paths, no-draft create, PR template body, retry existing-PR lookup after create failure before REST fallback, REST fallback, missing `gh`, unauthenticated `gh`, unsupported remote, permission failure, defaultRemote-only behavior, non-FF push failure, argv/ref validation.
- `apps/daemon/src/review-diff.test.ts`: checkout lookup, base resolution origin-first/local-fallback, missing base, "not refreshed" base label, against-base merge-base range, staged vs unstaged same path, untracked, binary, deleted, rename, conflicted, submodule, symlink, mode-only, LFS pointer, binary rename, truncation thresholds, content cap, local-vs-PR divergence, opaque file ID validation, path traversal rejection.
- `apps/daemon/src/review-routes.test.ts`: review diff metadata/content, create PR route, push route, thread CRUD, anchor validation, 404/validation errors, and no comment composers before PR scope.
- `apps/daemon/src/daemon-mcp-tool.test.ts` and `packages/mcp/src/index.test.ts`: review tools default filters, create/reply/resolve/reopen, create PR, push branch, authority mismatch rejection, and explicit absence of diff-content tools.
- `apps/daemon/src/readiness.test.ts` or checkout gate tests: only open/current internal threads block checkout readiness and readiness revalidates anchors before counting.
- `apps/web/src/routes/checkout-review*.test.tsx`: section ordering, thread panel filters, resolved expansion/reopen, file-level composer, agent author label, warning rendering, viewed state, sanitized markdown comments, malicious links/raw HTML, focus handling, keyboard navigation, composer open/cancel/submit, and accessible labels.
- `apps/web/src/inspector*.test.tsx`: Diff tab entry links to checkout review route and handles multiple checkouts without guessing.
- `e2e/diff-review.spec.ts`: open review from Diff tab, create-PR button when no PR exists, existing PR loads comments, add line/file comment, resolve/reopen, viewed file state, desktop screenshot, and mobile smoke screenshot.

### Existing Tests To Update

- `apps/daemon/src/pr-diff-route.test.ts`: assert the legacy PR diff route delegates to or remains compatible with the new checkout review diff service.
- `apps/daemon/src/workspace-diff.test.ts` and `apps/daemon/src/workspace-diff-routes.ts` tests: preserve compact inspector diff behavior or document any compatibility change.
- `apps/web/src/inspector*.test.tsx`: update Diff tab placeholder to the checkout review route entry.
- `apps/web/src/navigator-workspace-cards.test.ts` or checkout card tests: internal unresolved comment count contributes correctly without overriding conflicts/check failures.

### Assertions To Add Or Tighten

- Creating a PR with dirty/staged changes returns warnings and does not include those changes.
- Existing PR detection returns/upserts instead of creating a duplicate and does not push.
- Zero commits ahead of base blocks PR creation.
- Detached HEAD blocks PR creation.
- Non-FF `push_branch` fails clearly and never force-pushes.
- `create_review_thread` rejects anchors that are not current and marks previously valid anchors outdated after exact validation fails.
- `list_review_threads` defaults to `open + current`.
- Merged PR retention hard-deletes threads/replies/viewed state by cascade only after fresh provider observation.
- Closed-unmerged retention does not prune before the grace window.
- Resolved and outdated threads never block checkout gates or workspace readiness.
- Internal comments never become public GitHub comments.
- Raw HTML and unsafe links in comment markdown are sanitized.
- Side-effectful MCP PR/push/thread tools respect daemon dispatch and agent tool authority.

### Failure Modes / Edge Cases / Regression Risks

- Wrong base ref could show the wrong committed diff. Tests must cover origin-first and local fallback.
- Workspace-vs-checkout ambiguity could attach comments to the wrong PR. Routes and tests must require or resolve a checkout.
- Staged and unstaged changes for the same path could collide. File identity tests must cover bucket separation.
- PR creation could accidentally include dirty work. Provider tests must assert no staging/committing and warnings.
- GraphQL rate limit fallback could duplicate PRs. Tests must assert existing-PR lookup before create and REST fallback behavior.
- Internal comments could grow SQLite forever. Retention tests must cover merged, closed, startup/reconcile, and cascade delete.
- Anchor validation could silently move comments. Tests must assert exact validation and outdated marking.
- `@pierre/diffs` worker/highlighting setup could render blank content. E2E screenshots and DOM checks should verify nonblank desktop/mobile review pages.
- Web could import daemon internals while sharing types. `make check` should catch architecture issues, and implementation should keep contracts in `packages/contracts`.
- Comment markdown could execute script if rendered unsafely. Sanitization tests must cover raw HTML, event handlers, and unsafe protocols.
- Provider misclassification could hard-delete internal comments. Retention tests must require a fresh successful terminal-state observation.

### Adversarial Analysis

- **How could this fail in production?** Git refs can be missing/stale, `gh` can be rate-limited, PR templates can be absent or nested, local HEAD can diverge from PR head, checkout selection can be ambiguous, and large diffs can exceed memory/render budgets.
- **What user actions trigger unexpected behavior?** Creating a PR with dirty changes, commenting on staged/unstaged lines that are later edited, force-pushing/rebasing outside Citadel, reopening a closed PR, switching selected checkout while diff content is loading, and resolving a thread that the user later disagrees with.
- **What existing behavior could break?** Existing PR refresh/cooldown, checkout gate status, readiness ordering, inspector Diff compact list, MCP handler boundaries, and SQLite migrations.
- **Which tests credibly catch those failures?** Provider command tests, review diff git-fixture tests, DB retention tests, MCP daemon-handler tests, readiness/gate tests, and Playwright review-route tests.
- **What gaps remain?** Real GitHub API behavior still needs manual verification with `gh`; public GitHub comments are future work; exact anchor validation intentionally does not preserve comments across substantial code motion.

## Tests

TDD order:

- Contracts schemas.
- DB migration and internal review store helpers.
- Provider PR creation/push helpers.
- Operation-backed daemon actions.
- Diff metadata/content service.
- HTTP routes.
- MCP definitions and daemon handlers.
- Readiness/checkout gate integration.
- Frontend route/components.
- Playwright E2E.

## Schema Or Contract Generation

No generated schema command is currently required beyond updating TypeScript/Zod contracts and package exports. If adding `@pierre/diffs` changes dependency metadata, update `pnpm-lock.yaml` with pnpm only.

## Verification

- `make check` - comprehensive local gate: architecture, size, typecheck, lint, Vitest, coverage, dependency checks, and build.
- `make e2e` - required for the new web review journey.
- `make smoke` - required because daemon HTTP routes, operation-backed actions, and MCP-adjacent actions change operator-visible APIs.
- `make performance` - required because large diff rendering and lazy content loading affect a hot review path.
