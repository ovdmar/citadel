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

[~] 1. Checkout rows and details show intended and detected PR identity and URL when available.
[~] 2. Checkout rows and details show PR draft state.
[~] 3. Checkout rows and details show PR review decision.
[ ] 4. Checkout details show PR title, author, branch, target branch, labels, head SHA, base ref, and mergeability when available.
[x] 5. Workspace details show PR review requests and approval/blocking review state when available — rendered as overlapping reviewer avatars plus `N approved · N changes · N pending` counters in the inspector PR meta row.
[ ] 6. PR state contributes to checkout implementation gate, workspace readiness, and next action.
[~] 7. Checkout rows render the PR icon with lifecycle color: grey when no PR exists, yellow when checks are pending, green when checks pass, red when checks fail or conflicts block.
[ ] 8. The PR icon on a checkout row links directly to the provider PR URL.
[ ] 9. Checkout rows render a separate approval/review-artifact icon: grey when no review is required yet, yellow when pending/stale, red when blocking findings exist, green when the current head SHA is reviewed.
[x] 10. Checkout rows always reserve a PR slot, even when no PR exists.
[x] 11. The PR row exposes a copy-branch affordance for the head branch, and uses GitHub's `base ← head` direction.
[x] 12. Stacked PRs are modeled through checkout stack relationships and can also be detected by comparing each PR's base ref to other open and recently-merged PRs in the same head repository. When a parent is detected, the checkout row and inspector show an `↑ #<parent-number>` chip linking to that PR; merged parents are rendered with a distinct tone.
[x] 13. The inspector PR card surfaces a single action button at its bottom-right. It renders Merge when the PR is open and the GitHub CLI is healthy — respecting the repository's allowed merge strategies (squash/merge/rebase), allowing an explicit admin-bypass option for unmet GitHub repository requirements, and never deleting the head branch by default — and switches to Fix conflicts when `mergeable === "conflicting"` or `mergeStateStatus === "DIRTY"`. Merge and Fix conflicts are mutually exclusive (a conflicting PR cannot be merged); merged or closed PRs render no action.
[~] 14. GitHub's `mergeable` and `mergeStateStatus` fields are surfaced through `PullRequestSummary`. `mergeable !== "CONFLICTING"` is required for the `ready-to-merge` readiness state; `mergeStateStatus` informs the workspace-card tone only. These fields are refreshed when (a) the PR's own `headSha` changes, (b) the repo's default-branch SHA moves (detected by the per-repo merge-to-main watcher), or (c) the operator clicks force-refresh — never on every poll.
[~] 15. When `mergeable === "CONFLICTING"`, the workspace enters the dedicated `pr-conflicts` readiness state, distinct from the local working-tree `conflicts` state and from `checks-failing`. The workspace-card tone also flips to `conflicting` when `mergeStateStatus === "DIRTY"`, but the readiness state itself remains scoped to `mergeable === "CONFLICTING"`.
[ ] 16. Structured checkout gates consume durable checkout PR facts keyed by provider instance/account, repository identity, checkout id, PR identity, and head SHA. Workspace-level PR caches may render UI summaries but cannot satisfy structured readiness on their own.

## Checks And CI

[~] 1. Workspace cards and details show check/CI summary.
[ ] 2. Workspace details show the full checklist of checks with name, status, conclusion, and details URL when available.
[ ] 3. Failed checks show failure count and direct links to details.
[ ] 4. Pending checks show elapsed time and pending count.
[ ] 5. Green checks contribute to ready-for-review or ready-to-merge readiness.
[ ] 6. Stale check data is visible.
[x] 7. The inspector renders all PR commits (not just local recent commits) with a "Show more" expander when the list exceeds 5; each commit shows a per-commit check-roll-up dot (passing/pending/failing).
[x] 8. The inspector exposes a manual force-refresh control for PR and check state, and a live-ticking "Last fetched X ago" timestamp drawn from `versionControl.checkedAt`.
[ ] 9. Structured checkout gates consume durable check facts keyed by provider instance/account, repository identity, checkout PR/head binding, and check identity. Stale or degraded check facts are visible and block readiness.

## Implementation Gates And Review Artifacts

[ ] 1. A checkout is ready for human review only when PR exists, checks are green, mergeability has no conflicts, provider facts are fresh, current PR head SHA has a `review-pr` artifact for the active plan version, and no unresolved blocking review finding or plan deviation affects the checkout.
[ ] 2. `review-pr` is a built-in implementation action launched in a separate session. Its artifact stores checkout id, PR id/url, head SHA, plan version, result, findings status, blocking findings, artifact path/link, timestamp, and human waiver decisions.
[ ] 3. Any PR head SHA change invalidates the previous review artifact. Conflict fixes, CI fixes, restacks, manual commits, or plan version mismatches also invalidate readiness.
[ ] 4. Implementation agents signal completion through a structured tool, but manager independently verifies all gate facts before marking the checkout ready.
[ ] 5. Manager and implementation agents cannot self-waive blocking review findings. Only a recorded human decision can waive a blocking finding.
[ ] 6. Conflict appearance after readiness revokes readiness and triggers fix/restack automation when automation is unpaused.
[ ] 7. `mark_checkout_ready_for_review` records implementation completion plus PR/head facts and notes only; it does not create a review artifact.
[ ] 8. `register_checkout_review_artifact` records review artifacts only for server-linked `implementation.review_pr` action sessions or explicit local human imports.
[ ] 9. Review artifacts include `invalidatedAt`, `invalidatedReason`, explicit human waiver fields, and the plan/head identity needed to show stale artifacts without satisfying the gate.

## Stacked PRs And Restacking

[ ] 1. Plan dependency edges distinguish `parallel`, `stacked_on_pr`, `wait_for_merge_or_release`, and `manual` checkpoints.
[ ] 2. For same-repo stacked work, downstream checkouts start from the upstream branch/head after upstream CI is green and the current head has passed `review-pr`.
[ ] 3. Base branch updates cascade from bottom to top. Upstream checkout changes mark downstream checkouts `needs_restack`.
[ ] 4. Manager owns restack orchestration in v1: update bottom checkout from base, update each child from parent, launch conflict/restack actions when needed, then re-run gates for changed checkouts.
[ ] 5. Force-push, upstream branch deletion, manual rebase, partial stack failure, and stale/unknown provider state are explicit restack states, not silent success.
[ ] 6. Automated restack acquires a per-checkout/worktree mutation lock, refuses dirty/diverged/conflicted checkouts, blocks when unrelated mutating sessions are active, creates backup refs before branch rewriting, re-checks cleanliness and lock ownership before each mutating git command, and never force-pushes by default.
[ ] 7. Restack conflicts stop the affected branch of the cascade, record a visible operation/gate reason, and launch the configured conflict/restack action only when automation is unpaused.

## Background Refresh

[x] 1. PR state for every workspace with a remote and an open PR is refreshed in the background on a per-PR adaptive cadence decided by the daemon: 60s default while checks are pending/failing, 10min metadata-only refresh once checks are green, no automatic refresh for merged, closed, or conflicting PRs until a new local PR commit is detected. The cockpit asks at a 60s batch rhythm and refetches the active workspace on focus / SSE invalidation; the daemon serves cache or fetches based on the per-PR schedule and a shared global PR cache.
[x] 2. Background polling pauses when the cockpit tab is hidden (`document.visibilityState === 'hidden'`) and resumes on focus. It also pauses entirely when no cockpit tab is connected at all (no SSE viewers) after a 2-minute grace window so brief tab-reloads don't trip it.
[x] 3. Workspaces with no remote, repository-root workspaces, workspaces with no PR, and PRs in merged/closed/conflicting states are skipped to avoid useless gh invocations. Workspaces in active gh-cooldown are not skipped — they are queued and served from snapshot/cache.
[x] 4. PRs tracked by multiple workspaces share a single cached `PullRequestSummary` keyed by `owner/repo#number`; both the active-workspace fetch and stacked-PR detection consult daemon-owned caches before spawning GitHub CLI work.

## GitHub Rate Limiting

[x] 1. When any gh subprocess returns a rate-limit error ("API rate limit exceeded", "secondary rate limit", "abuse rate limit"), the daemon enters a 15-minute global cooldown. Every subsequent gh call short-circuits without spawning a subprocess.
[x] 2. Cooldown state surfaces to the FE through `versionControl.cooldownUntil` (ISO timestamp). The pr-routes response builder decorates every outgoing `versionControl` payload with this field during cooldown — regardless of whether the payload came from a fresh fetch, a scheduler-skip cache fallback, or a stale snapshot.
[x] 3. The cockpit renders a single top-of-page pill "GitHub rate-limited — retrying at HH:MM" when any workspace carries a non-null `cooldownUntil` in the sticky cache. Last-known PR data stays visible underneath.
[x] 4. Force-refresh (`pr-refresh` endpoint) during cooldown returns 200 + the cached snapshot decorated with `cooldownUntil`, not 503 — the FE banner explains the situation; no special-case error toast.
[x] 5. Worktree deploys started by `make deploy` disable automated GitHub polling by default; only the long-term install enables it. A worktree can opt in with `CITADEL_ENABLE_WORKTREE_GH_AUTOMATION=1 make deploy`.

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
[ ] 12. Fullscreen review diff is scoped to a selected worktree checkout. It shows `Committed vs base`, `Staged`, and `Unstaged` sections, resolves base from the checkout `baseBranch` preferring `origin/<baseBranch>`, and never fetches during diff load.
[ ] 13. Review diff metadata and lazy file-content endpoints use opaque file ids, keep staged/unstaged/against-base identities separate for the same path, reject path traversal, and expose explicit binary, deleted, rename, conflicted, submodule, symlink, mode-only, LFS pointer, truncation, and too-large states.

## Human Review

[ ] 1. Full-screen *Human Review* mode is reachable from the inspector `Diff` tab and from checkout PR/review context without unmounting the cockpit.
[ ] 2. Human Review presents checkout files in a GitHub-style continuous side-by-side review surface with sticky file headers, a file outline, viewed state, and lazy file content.
[ ] 3. If the selected checkout has no PR, Human Review still shows the local diff and offers a GitHub/`gh` create-PR action; internal comment composers stay disabled until a PR-backed review scope exists.
[ ] 4. Create-PR never creates draft PRs, respects repository PR templates when present, never stages or commits dirty work, warns about staged/unstaged changes excluded from the pushed PR, and falls back from GraphQL-specific rate limiting to REST only after rechecking for an already-created PR.
[ ] 5. Internal review threads support line/range comments, file-level comments, replies, `open`/`resolved` lifecycle, resolved expansion, reopen, `authorKind`, exact anchor revalidation, and `current`/`outdated` anchor state.
[ ] 6. Internal comments remain private Citadel state forever. Future public/provider comments are a distinct `kind`; external comments are read-only until a separate public-comment feature exists.
[ ] 7. Agents can list, create, reply to, resolve, and reopen internal review threads through MCP using checkout/review-scope targets and file/line anchors from their local code context. MCP does not expose diff content.
[ ] 8. Open/current internal review threads contribute to the selected checkout gate as `review_blocked`, below conflicts, check failures, and stale provider facts. Resolved and outdated threads never block readiness.
[ ] 9. Internal review data is stored in first-class SQLite tables. Merged PR scopes are hard-deleted only after a fresh merged provider observation; closed-unmerged scopes are pruned after a short grace window; stale, unavailable, rate-limited, or misconfigured provider states never delete review data.

---

keywords: git, branch, status, pr, review, checks, ci, diff, additions, deletions, provider
