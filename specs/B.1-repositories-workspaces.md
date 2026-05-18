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

## Create Workspace

[ ] 1. A workspace maps to a git worktree.
[ ] 2. Create workspace supports a blank/new branch workspace.
[ ] 3. Create workspace supports a workspace from an existing branch.
[ ] 4. Create workspace supports a workspace from a PR.
[ ] 5. Create workspace supports a workspace from a Jira issue.
[ ] 6. Create workspace previews branch name, path, base branch, linked PR/issue, and setup hooks before creation.
[ ] 7. Create workspace executes repo setup hooks through operations.
[ ] 8. A created workspace appears in the navigator with readiness, git state, and session affordances.

## Archive And Remove Workspace

[ ] 1. Archive workspace keeps history while hiding the workspace from active cockpit views.
[ ] 2. Remove workspace explains worktree, sessions, operations, and hook cleanup impact.
[ ] 3. Remove workspace requires explicit confirmation when active sessions or dirty files exist.
[ ] 4. Remove workspace can run repo teardown hooks.
[ ] 5. Remove workspace can preserve the worktree on disk when selected.
[ ] 6. Workspace lifecycle is tracked separately from agent session, terminal, git, PR, and deployment state.

---

keywords: repositories, add repository, remove repository, workspaces, create workspace, git worktree, navigator, grouping, readiness
