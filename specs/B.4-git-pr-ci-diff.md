# [B.4] Git, PR, CI, And Diff

**Status:** Draft

> Citadel gives the operator enough code-review state to decide whether to inspect, fix, wait, deploy, or merge.

## Git Status

[~] 1. Workspace cards and details show branch identity.
[~] 2. Workspace cards and details show dirty state.
[~] 3. Workspace cards and details show modified, staged, untracked, deleted, renamed, and conflicted counts.
[~] 4. Workspace cards and details show ahead/behind counts.
[~] 5. Workspace details show raw git status lines for fast inspection.
[~] 6. Workspace details show additions/deletions and changed file counts.
[ ] 7. Git status shows refresh time and stale state.
[ ] 8. Git status shows conflicts as high-attention readiness input.
[x] 9. Workspace details show a "Recent" section listing the most recent commits with short sha, subject, author, and relative time.

## PR Identity

[~] 1. Workspace cards and details show PR identity and URL when available.
[~] 2. Workspace cards and details show PR draft state.
[~] 3. Workspace cards and details show PR review decision.
[ ] 4. Workspace details show PR title, author, branch, target branch, labels, and mergeability when available.
[x] 5. Workspace details show PR review requests and approval/blocking review state when available — rendered as overlapping reviewer avatars plus `N approved · N changes · N pending` counters in the inspector PR meta row.
[ ] 6. PR state contributes to readiness and next action.
[ ] 7. Workspace cards render the PR icon with lifecycle color: grey when no PR exists, yellow when the PR exists and checks are pending, green when checks pass, red when any check fails.
[ ] 8. The PR icon on a workspace card links directly to the provider PR URL.
[ ] 9. Workspace cards render a separate approval icon to the right of the PR icon: grey when no reviewer is requested, yellow when reviewers are pending, red when changes are requested or comments are unresolved, green check when at least one approval exists.

## Checks And CI

[~] 1. Workspace cards and details show check/CI summary.
[ ] 2. Workspace details show the full checklist of checks with name, status, conclusion, and details URL when available.
[ ] 3. Failed checks show failure count and direct links to details.
[ ] 4. Pending checks show elapsed time and pending count.
[ ] 5. Green checks contribute to ready-for-review or ready-to-merge readiness.
[ ] 6. Stale check data is visible.

## Diff

[~] 1. Workspace detail includes a read-only diff panel.
[ ] 2. Diff behavior is close to local git diff for normal text changes.
[ ] 3. Diff panel has a summary header with file counts, additions, deletions, and truncation state.
[ ] 4. Diff panel handles large diffs with clear truncation state.
[ ] 5. Diff panel handles binary files.
[ ] 6. Diff panel handles deleted files.
[ ] 7. Diff panel handles untracked files.
[ ] 8. Diff panel handles conflicted files.
[ ] 9. Diff summary is connected to readiness and PR/check state.
[ ] 10. The diff/review surface is read-only.
[ ] 11. The inspector `Diff` tab shows the changed files list with additions/deletions per file in a compact list.

## Human Review

[ ] 1. A future full-screen *Human Review* mode is reachable from the inspector `Diff` tab.
[ ] 2. Human Review presents files in a GitHub-style review surface.
[~] 3. Inspector hosts a `Review` tab that accepts workspace-level and file/line comments persisted in Citadel's SQLite (not posted to GitHub). The full diff-anchored inline renderer is still planned (item 2); v1 ships a flat list with file:line anchors shown above each comment.
[~] 4. Comments are visible to the active agent session as structured input via MCP tools `list_review_comments`, `add_review_comment`, `update_review_comment`, `delete_review_comment`. The MCP path stamps `author = 'agent:<runtime-id>'`; the cockpit HTTP path stamps `author = 'operator'`. Mutations carry an `ifUpdatedAtMatches` token for optimistic concurrency (409 on mismatch).
[~] 5. Comments are scoped to the selected workspace. Archived workspaces are filtered out of default listings; `includeArchived` is an explicit opt-in.

### Request Review

[~] 1. A repo can configure a `workspace.requestReview` hook (event added to `HookEventSchema` in `@citadel/config`). The hook receives `{ workspace, repo, pr, diff: { files, addedLines, deletedLines, truncated } }` on stdin and returns a validated `ReviewSuggestionsOutput` payload on stdout.
[~] 2. The inspector exposes a "Request review" button next to (or above) the `Diff`/`Review` surface. When no `workspace.requestReview` hook is configured, the button is disabled with a tooltip pointing operators at the Settings UI hook editor.
[~] 3. Each invocation records one `activity_events` row (`hook.workspace.requestReview` on success, `hook.workspace.requestReview.failed` on failure or timeout) plus a `review_suggestion_runs` row that preserves parsed output (success), raw stderr tail, and error message (failure).
[~] 4. Suggestion entries carry a `kind` (`reviewer`, `checklist`, `note`, `warning`), `label`, optional `detail`, optional `url` (constrained to http/https schemes), and optional `metadata`.

### Retention

v1 has no retention policy for `review_suggestion_runs` or `activity_events`; both grow unbounded. Bulk-resolve or auto-archive on merged PRs is a follow-up.

---

keywords: git, branch, status, pr, review, checks, ci, diff, additions, deletions, provider, comments, mcp, request review, hook
