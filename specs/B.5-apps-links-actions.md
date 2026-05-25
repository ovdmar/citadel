# [B.5] Apps, Links, And Actions

**Status:** Draft

> Citadel shows worktree-specific applications, links, and deploy-style actions as workspace cockpit primitives.

## Workspace Apps

[~] 1. A workspace can show deployed applications for that worktree.
[ ] 2. Workspace applications come from repo-level structured hooks.
[ ] 3. Application entries include name, URL, status, health, environment, version, commit, and metadata when available.
[ ] 4. Application entries show the source hook/provider and refresh age.
[ ] 5. Missing app data explains whether the hook is absent, unhealthy, failed, or returned no apps.
[ ] 6. Application health contributes to workspace readiness when configured.
[ ] 7. The inspector `Stats` tab renders deployed apps as clickable chips with red/green deploy/status color.
[ ] 8. App discovery hooks must support monorepos by returning only the subset of services the current workspace actually touches.
[ ] 9. The list of services is dynamic per workspace; no static list is hardcoded in Citadel.
[ ] 10. App chips expose a redeploy action when the repo declares one; redeploy runs through Citadel operations.

## Links

[~] 1. A workspace can show relevant links returned by providers and hooks.
[ ] 2. Link examples include PR, Jira, Slack thread, preview app, logs, docs, dashboard, and external deployment surface.
[ ] 3. Links are visually distinct from executable actions.
[ ] 4. Links include label, URL, category, provider/hook source, and optional status.
[ ] 5. Links can be grouped by app, provider, or purpose.

## Actions

[ ] 1. A workspace can show executable actions returned by repo hooks. (Was partially shipped via an inspector chip row; the redesign removed that surface — the Local deploys section now shows only chip + per-chip Redeploy. A dedicated home for repo-level actions is TBD.)
[ ] 2. Action examples include redeploy, restart, open logs, refresh provider, run setup, or run teardown.
[ ] 3. Executable actions run through Citadel operations.
[ ] 4. Action execution captures stdout, stderr, result, duration, and failure text.
[ ] 5. Latest action result is visible near the workspace.
[ ] 6. Failed actions are visible and retryable where safe.
[ ] 7. Action safety level and confirmation requirements are explicit.
[ ] 8. Running actions show progress and disable conflicting actions.
[ ] 9. Completed actions record activity on the workspace.

## Deploy Workflow

[ ] 1. A workspace with deployable apps shows preview/deploy status in the cockpit.
[ ] 2. The operator can trigger redeploy for a returned app/action.
[ ] 3. Redeploy output remains visible after completion.
[ ] 4. Redeploy failure shows the failing command/output summary and full operation log access.
[ ] 5. Redeploy success updates app status, activity, and readiness.

---

keywords: applications, links, actions, deploy, redeploy, repo hooks, preview, logs, operation output
