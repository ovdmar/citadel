# [B.1] Repository And Workspace Model

**Status:** Draft

> Repos and workspaces are Citadel's core operating units.

## Repository List

[~] 1. Citadel tracks multiple repositories.
[ ] 2. The repository list shows name, path, provider health, workspace count, active session count, and attention state.
[ ] 3. The repository list supports adding an existing local git repository.
[ ] 4. The repository list supports registering a cloned repository by path.
[ ] 5. The repository list supports opening repository settings.
[ ] 6. The repository list supports removing a repository from Citadel tracking.
[ ] 7. Removing a repository from Citadel defaults to preserving the local git repository and offers explicit cleanup as a separate choice.

## Add Repository

[ ] 1. The add repository flow accepts a local path.
[ ] 2. The add repository flow validates that the path is a git repository.
[ ] 3. The add repository flow detects remotes, default branch, current branch, and provider candidates.
[ ] 4. The add repository flow shows which providers can activate for the repository.
[ ] 5. The add repository flow lets the operator choose setup, teardown, app discovery, and action hooks.
[ ] 6. The add repository flow validates configured hooks before saving.
[ ] 7. A successfully added repository appears immediately in the repository/workspace navigator.
[ ] 8. A failed add repository flow shows the exact validation issue and keeps entered values editable.
[ ] 9. The add repository entry point is the small icon button next to the *Workspaces* header in the navigator.
[ ] 10. The add repository overlay supports three input modes: local filesystem path, GitHub repo URL, and GitHub repo search (via `gh api --method GET search/repositories` when the GitHub provider is healthy).
[ ] 11. When the chosen repository is not yet cloned locally, the overlay clones it under `~/Workspace/<repo>` (or the configured workspace root) before registering it with Citadel.
[ ] 12. The clone step runs as an operation with progress and explicit failure surface.

## Repository Settings

[ ] 1. A repository has stable identity independent of local path.
[ ] 2. Repository settings show path, remotes, branches, provider activation, hooks, workspace defaults, and diagnostics.
[ ] 3. Repository settings allow path metadata refresh after the repo is moved.
[ ] 4. Repository settings allow provider activation/deactivation.
[ ] 5. Repository settings allow hook configuration and validation.
[ ] 6. Repository settings show last successful and failed hook runs.
[ ] 7. Repository-specific behavior is visible as configuration.

## Remove Repository

[ ] 1. Remove repository explains what Citadel will stop tracking.
[ ] 2. Remove repository shows existing workspaces, sessions, operations, and hooks affected by removal.
[ ] 3. Remove repository requires explicit confirmation when active sessions or running operations exist.
[ ] 4. Remove repository can keep worktrees on disk.
[ ] 5. Remove repository can offer explicit cleanup for Citadel-created worktrees when safe.
[ ] 6. Remove repository records an activity event with the chosen cleanup mode.
[ ] 7. Removed repositories disappear from the navigator and remain recoverable from durable state/history where appropriate.

## Workspace List

[~] 1. Citadel tracks multiple workspaces, each with a root directory and a mode.
[ ] 2. Workspaces appear as top-level navigator rows. Each workspace row expands to an unremovable `Home` child and zero or more worktree checkout children.
[ ] 3. Freestyle workspaces preserve today's manual worktree behavior. Structured workspaces are feature containers for automated delivery and may begin with no checkout.
[ ] 4. Workspace rows show title, mode, lifecycle, parent issue, manager pause/attention state, active session count, and aggregate gate status.
[ ] 5. Checkout rows show repo, branch, inferred purpose, dirty state, PR/check/conflict state, child issue binding, and implementation gate status.
[ ] 6. The navigator remains scannable with 10-12 active workspaces across 2-3 repositories and supports larger structured workspaces by collapsing checkout children.
[ ] 7. Workspace title is editable inline. Checkout display names are unique within a workspace and default to repo or delivery-unit names.
[ ] 8. Grouping by repository remains available for freestyle workspaces, but structured workspaces stay grouped by feature root so Home/checkouts remain visually together.
[ ] 9. Workspace-level history, manager state, plan versions, and local notifications are reachable from the workspace row and Home target.

## Workspace Modes And Creation

[ ] 1. A freestyle workspace maps to one manually chosen repository worktree and remains valid without structured manager gates.
[ ] 2. A structured workspace creates a root directory, writes `.citadel/workspace.json`, creates Home, optionally binds a parent issue, creates one manager instance, and may start with zero checkouts.
[ ] 3. PM bootstrap can create a structured workspace shell from an idea or parent issue without requiring a repository or checkout.
[ ] 4. Prototype requires a checkout target but does not require an active plan or child ticket binding.
[ ] 5. Structured implementation requires an active approved workspace plan, a parent issue binding, and exactly one child ticket binding on the target checkout.
[ ] 6. Checkout creation supports a scratch branch off repo default branch, existing branch, PR, and upstream checkout branch/head for stacked work.
[ ] 7. Multiple checkouts in one workspace may point to the same repository. One checkout is one branch and one intended PR.
[ ] 8. Worktree checkouts live under the workspace root and store repo id, path, branch, base branch, issue binding, intended PR binding, stack parent, inferred purpose, gate status, timestamps, and archive fields.
[ ] 9. Create workspace and create checkout run through operations, surface setup progress, and leave failed attempts recoverable.
[ ] 10. Provider-less discovery/prototype/architecture are valid structured states. Provider-less coding remains a freestyle launch, not structured implementation.

## Workspace Layout Migration

[ ] 1. Existing single-repo workspaces migrate automatically once to the root + checkout layout when safety checks pass.
[ ] 2. Migration preserves `workspaces.path` as the legacy/current-primary-checkout path during compatibility while new code reads `workspaces.root_path` and `workspace_checkouts.path`.
[ ] 3. Migration moves Git worktrees using `git worktree move` only. Raw directory moves are not used for automatic migration.
[ ] 4. The automatic path uses a sibling temporary checkout path, creates the final workspace root at the old operator-visible path, then moves the checkout under that root.
[ ] 5. Dirty worktrees may be migrated only when pre/post `git status --porcelain` output matches and git metadata remains valid.
[ ] 6. Migration writes a manifest before moving, skips live sessions/operations, verifies branch/HEAD/common-dir/worktree-list state, updates DB only after verification, and is idempotent after crashes.
[ ] 7. Cross-device moves, target collisions, root/imported repositories, missing paths, and broken git state are skipped without mutating the DB and surface a visible admin/readiness item.

## Archive And Remove Workspace

[ ] 1. Archive workspace keeps history while hiding the workspace from active cockpit views.
[ ] 2. Remove workspace explains root directory, checkouts, sessions, operations, hooks, plan artifacts, manager state, and provider bindings affected by cleanup.
[ ] 3. Remove workspace requires explicit confirmation when active sessions, active manager actions, dirty checkout files, or unpushed checkout commits exist.
[~] 4. Remove workspace runs repo teardown hooks before tmux/worktree cleanup; both `repo.teardownHookIds` and an executable `.citadel/hooks/teardown` are honored (file first, then configured).
[ ] 5. Remove workspace can preserve the root/checkouts on disk when selected. Checkout archive/remove paths retain dirty-worktree protection.
[ ] 6. Workspace lifecycle is tracked separately from agent session, terminal, git, PR, and deployment state.
[ ] 7. Archived/removed workspaces remain visible from the *History* navigator entry.
[ ] 8. The history view distinguishes fully-removed workspaces from archived workspaces whose worktree is still present on disk.
[ ] 9. The history view records the PR snapshot at archive time (state, additions/deletions, link) so it remains visible even after the PR provider stops returning it.
[ ] 10. The history view offers an unarchive control when the worktree is still present and the workspace can be safely returned to active lifecycle.
[ ] 11. Remove workspace removes the row from the navigator optimistically on confirmation; teardown continues in the background. The row only re-renders if backend cleanup fails (or on a page reload before the DELETE response). On failure, the drop dialog re-opens for the resurrected workspace seeded with the error message — even if the user has navigated to a different workspace in the meantime.
[ ] 12. When removal is blocked by a dirty worktree, the dialog surfaces the actual change summary: a list of uncommitted file paths with their git porcelain status code, and a list of unpushed commits with short SHA + subject. Lists are capped at 50 files and 20 commits.

---

keywords: repositories, add repository, remove repository, workspaces, create workspace, git worktree, navigator, grouping, readiness
