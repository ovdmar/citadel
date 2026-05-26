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
[ ] 10. The add repository overlay supports three input modes: local filesystem path, GitHub repo URL, and GitHub repo search (via `gh repo list`/`gh search repos` when the GitHub provider is healthy).
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

[~] 1. Citadel tracks multiple workspaces per repository.
[~] 2. Workspaces appear in a compact left-side navigator.
[~] 3. Workspaces are grouped by repository.
[ ] 4. Workspaces are grouped or sorted by readiness/status inside each repository.
[ ] 5. Workspace rows show branch, readiness, active session count, dirty state, PR/check state, and blocking operations.
[ ] 6. The navigator remains scannable with 10-12 active workspaces across 2-3 repositories.
[ ] 7. The navigator is the primary left-side operating surface.
[ ] 8. Workspace rows are slim (two lines): left agent state icon, first line workspace title, second line branch name in lighter monospace.
[ ] 9. Workspace title is editable inline. Default is the worktree name; when an issue is attached the default is `<issue-key> · <issue-title> · <workspace-name>`.
[ ] 10. The agent state icon shows a spinner while an *agent* session (any runtime except the plain `shell` terminal) is starting or actively running, and a static icon when only plain terminals or no sessions are running.
[ ] 11. The navigator exposes a group-by overlay with checkboxes for `Repository` and `Status`. Both are reorderable to control grouping order. Default: both on, Repository first.
[ ] 12. Group-by preferences persist locally.

## Create Workspace

[ ] 1. A workspace maps to a git worktree.
[ ] 2. Create workspace supports a blank/new branch workspace.
[ ] 3. Create workspace supports a workspace from an existing branch.
[ ] 4. Create workspace supports a workspace from a PR.
[ ] 5. Create workspace supports a workspace from a Jira issue.
[ ] 6. Create workspace previews branch name, path, base branch, linked PR/issue, and setup hooks before creation.
[ ] 7. Create workspace executes repo setup hooks through operations.
[ ] 8. A created workspace appears in the navigator with readiness, git state, and session affordances.
[ ] 9. The create workspace entry point is the plus icon button next to the *Workspaces* header in the navigator. It opens a centered modal.
[ ] 10. The modal requires repository selection first. The most recently used repository is pre-selected, and a search input is available when many repositories are registered.
[ ] 11. The modal exposes workspace source as tabs: `From scratch`, `From issue`, `From branch`.
[ ] 12. The `From issue` tab queries the active issue provider for issues assigned to or created by the current user, sorted by most recent activity.
[ ] 13. The `From branch` tab lists recent local and remote branches with an inline branch search.
[ ] 14. The modal supports an optional initial agent task that auto-launches a chosen runtime when the workspace is created.
[ ] 15. When the workspace is created from this modal and a default agent runtime exists for the repo, Citadel opens that agent in the center column immediately.

## Archive And Remove Workspace

[ ] 1. Archive workspace keeps history while hiding the workspace from active cockpit views.
[ ] 2. Remove workspace explains worktree, sessions, operations, and hook cleanup impact.
[ ] 3. Remove workspace requires explicit confirmation when active sessions or dirty files exist.
[~] 4. Remove workspace can run repo teardown hooks (resolved from `repo.teardownHookIds` and/or an executable `.citadel/hooks/teardown` in the workspace).
[ ] 5. Remove workspace can preserve the worktree on disk when selected.
[ ] 6. Workspace lifecycle is tracked separately from agent session, terminal, git, PR, and deployment state.
[ ] 7. Archived/removed workspaces remain visible from the *History* navigator entry.
[ ] 8. The history view distinguishes fully-removed workspaces from archived workspaces whose worktree is still present on disk.
[ ] 9. The history view records the PR snapshot at archive time (state, additions/deletions, link) so it remains visible even after the PR provider stops returning it.
[ ] 10. The history view offers an unarchive control when the worktree is still present and the workspace can be safely returned to active lifecycle.

---

keywords: repositories, add repository, remove repository, workspaces, create workspace, git worktree, navigator, grouping, readiness
