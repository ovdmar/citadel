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
[x] 10. Workspace cards always render a PR row, even when no PR exists — an explicit thin placeholder makes the lifecycle slot visible without requiring workspace selection.
[x] 11. The PR row exposes a copy-branch affordance for the head branch, and uses GitHub's `base ← head` direction.
[x] 12. Stacked PRs are detected by comparing each PR's base ref to other open and recently-merged PRs in the same head repository. When a parent is detected, the workspace card and inspector show an `↑ #<parent-number>` chip linking to that PR; merged parents are rendered with a distinct tone.
[x] 13. The inspector PR card surfaces a single action button at its bottom-right. It renders Merge when the PR is open and the GitHub CLI is healthy — respecting the repository's allowed merge strategies (squash/merge/rebase) and never deleting the head branch by default — and switches to Fix conflicts when `mergeable === "conflicting"` or `mergeStateStatus === "DIRTY"`. Merge and Fix conflicts are mutually exclusive (a conflicting PR cannot be merged); merged or closed PRs render no action.
[~] 14. GitHub's `mergeable` and `mergeStateStatus` fields are surfaced through `PullRequestSummary`. `mergeable !== "CONFLICTING"` is required for the `ready-to-merge` readiness state; `mergeStateStatus` informs the workspace-card tone only. These fields are refreshed when (a) the PR's own `headSha` changes, (b) the repo's default-branch SHA moves (detected by the per-repo merge-to-main watcher), or (c) the operator clicks force-refresh — never on every poll.
[~] 15. When `mergeable === "CONFLICTING"`, the workspace enters the dedicated `pr-conflicts` readiness state, distinct from the local working-tree `conflicts` state and from `checks-failing`. The workspace-card tone also flips to `conflicting` when `mergeStateStatus === "DIRTY"`, but the readiness state itself remains scoped to `mergeable === "CONFLICTING"`.

## Checks And CI

[~] 1. Workspace cards and details show check/CI summary.
[ ] 2. Workspace details show the full checklist of checks with name, status, conclusion, and details URL when available.
[ ] 3. Failed checks show failure count and direct links to details.
[ ] 4. Pending checks show elapsed time and pending count.
[ ] 5. Green checks contribute to ready-for-review or ready-to-merge readiness.
[ ] 6. Stale check data is visible.
[x] 7. The inspector renders all PR commits (not just local recent commits) with a "Show more" expander when the list exceeds 5; each commit shows a per-commit check-roll-up dot (passing/pending/failing).
[x] 8. The inspector exposes a manual force-refresh control for PR and check state, and a live-ticking "Last fetched X ago" timestamp drawn from `versionControl.checkedAt`.

## Background Refresh

[~] 1. PR state for every workspace with a remote and an open PR is refreshed in the background on a per-PR adaptive cadence decided by the daemon: 60s default, 3min once checks are green and the head SHA has been stable for >10min, never once the PR is merged. The cockpit asks at a fast rhythm (60s batch, 30s active workspace); the daemon serves cache or fetches based on the per-PR schedule.
[~] 2. Background polling pauses when the cockpit tab is hidden (`document.visibilityState === 'hidden'`) and resumes on focus. It also pauses entirely when no cockpit tab is connected at all (no SSE viewers) after a 2-minute grace window so brief tab-reloads don't trip it.
[~] 3. Workspaces with no remote, repository-root workspaces, workspaces with no PR, and PRs in the merged state are skipped to avoid useless gh invocations. Workspaces in active gh-cooldown are not skipped — they are queued and served from snapshot/cache.

## GitHub Rate Limiting

[x] 1. When any gh subprocess returns a rate-limit error ("API rate limit exceeded", "secondary rate limit", "abuse rate limit"), the daemon enters a 15-minute global cooldown. Every subsequent gh call short-circuits without spawning a subprocess.
[~] 2. Cooldown state surfaces to the FE through `versionControl.cooldownUntil` (ISO timestamp). The pr-routes response builder decorates every outgoing `versionControl` payload with this field during cooldown — regardless of whether the payload came from a fresh fetch, a scheduler-skip cache fallback, or a stale snapshot.
[ ] 3. The cockpit renders a single top-of-page pill "GitHub rate-limited — retrying at HH:MM" when any workspace carries a non-null `cooldownUntil` in the sticky cache. Last-known PR data stays visible underneath.
[~] 4. Force-refresh (`pr-refresh` endpoint) during cooldown returns 200 + the cached snapshot decorated with `cooldownUntil`, not 503 — the FE banner explains the situation; no special-case error toast.

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

## Human Review (Planned)

[ ] 1. A future full-screen *Human Review* mode is reachable from the inspector `Diff` tab.
[ ] 2. Human Review presents files in a GitHub-style review surface.
[ ] 3. Human Review allows leaving file/line comments.
[ ] 4. Comments are visible to the active agent session as structured input.
[ ] 5. Human Review remains scoped to the selected workspace.

---

keywords: git, branch, status, pr, review, checks, ci, diff, additions, deletions, provider
