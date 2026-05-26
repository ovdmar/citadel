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
[~] 10. GitHub's `mergeable` and `mergeStateStatus` fields are surfaced through `PullRequestSummary`. `mergeable !== "CONFLICTING"` is required for the `ready-to-merge` readiness state; `mergeStateStatus` informs the workspace-card tone only.
[~] 11. When `mergeable === "CONFLICTING"`, the workspace enters the dedicated `pr-conflicts` readiness state, distinct from the local working-tree `conflicts` state and from `checks-failing`. The workspace-card tone also flips to `conflicting` when `mergeStateStatus === "DIRTY"`, but the readiness state itself remains scoped to `mergeable === "CONFLICTING"`.

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

## Human Review (Planned)

[ ] 1. A future full-screen *Human Review* mode is reachable from the inspector `Diff` tab.
[ ] 2. Human Review presents files in a GitHub-style review surface.
[ ] 3. Human Review allows leaving file/line comments.
[ ] 4. Comments are visible to the active agent session as structured input.
[ ] 5. Human Review remains scoped to the selected workspace.

---

keywords: git, branch, status, pr, review, checks, ci, diff, additions, deletions, provider
