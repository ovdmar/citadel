# [B.7] Operations, Activity, And MCP

**Status:** Draft

> Side effects are visible, durable operations. Automation uses the same product contracts as the UI.

## Operations

[~] 1. Long-running or side-effectful work has an operation ID.
[~] 2. Operations have status, progress, logs, error text, and related repo/workspace/session IDs.
[ ] 3. Add repository validation can create an operation when provider/hook checks are slow.
[ ] 4. Remove repository cleanup is an operation.
[ ] 5. Workspace creation is an operation.
[ ] 6. Workspace removal is an operation.
[ ] 7. Setup/teardown hook execution is an operation.
[ ] 8. Provider refresh is an operation when it can be slow or fail.
[ ] 9. Workspace action execution is an operation.
[ ] 10. Jira transition is an operation.
[ ] 11. Agent session start/resume is an operation.
[ ] 12. Running and failed workspace-specific operations are visible in the workspace cockpit.
[ ] 13. Operations support retry/cancel when safe.

## Activity

[~] 1. Citadel records activity events.
[ ] 2. Activity explains what happened, when, why, and through which provider/hook/action.
[ ] 3. Repository activity is visible from repository settings/detail.
[ ] 4. Workspace activity is visible in the selected workspace.
[ ] 5. Global activity exists for cross-repo monitoring.
[ ] 6. Activity provides enough context to debug failed setup, deploy, provider, or terminal flows.
[ ] 7. Activity links to related operation output.

## MCP

[~] 1. Citadel exposes MCP over normalized Citadel concepts.
[ ] 2. Agents can inspect repositories through MCP.
[ ] 3. Agents can add/register repositories through MCP when policy allows it.
[ ] 4. Agents can inspect workspaces through MCP.
[ ] 5. Agents can create workspaces through MCP.
[ ] 6. Agents can start or inspect agent sessions through MCP.
[ ] 7. Agents can inspect operation status through MCP.
[ ] 8. Agents can inspect readiness and next-action state through MCP.
[ ] 9. MCP actions follow the same operation, provider, hook, and safety model as the UI.
[ ] 10. MCP presents product contracts as its primary surface.

---

keywords: operations, activity, audit, progress, logs, mcp, automation, agents
