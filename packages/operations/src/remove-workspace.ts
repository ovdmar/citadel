// Extracted from `index.ts` to keep that file under the 800-line cap
// (`scripts/checks/file-size.ts`).

import fs from "node:fs";
import type { WorkspaceDirtySummary } from "@citadel/contracts";
import { nowIso } from "@citadel/core";
import { killTmuxSession } from "@citadel/terminal";
import type { WorkspaceOpsDeps } from "./create-workspace.js";
import { cleanupWorktree, workspaceDirtySummary, workspaceIsDirty } from "./helpers.js";

export type RemoveWorkspaceInput = { workspaceId: string; force?: boolean; archiveOnly?: boolean };

export type RemoveWorkspaceResult = {
  operationId: string;
  removed: boolean;
  archived: boolean;
  dirty: boolean;
  // Present only when removal was blocked by dirty state (`removed: false`
  // && `dirty: true`). Lists are capped server-side: ≤50 files, ≤20 commits.
  dirtySummary?: WorkspaceDirtySummary;
};

export type WorkspaceRemovalCheckResult = {
  removable: boolean;
  dirty: boolean;
  reason: "ok" | "root_workspace" | "dirty";
  dirtySummary?: WorkspaceDirtySummary;
};

export function checkWorkspaceRemovalImpl(
  deps: WorkspaceOpsDeps,
  input: { workspaceId: string; archiveOnly?: boolean },
): WorkspaceRemovalCheckResult {
  const workspace = deps.store.listWorkspaces().find((candidate) => candidate.id === input.workspaceId);
  if (!workspace) throw new Error(`Unknown workspace: ${input.workspaceId}`);
  if (workspace.kind === "root") {
    return { removable: false, dirty: false, reason: "root_workspace" };
  }
  const dirty = workspaceIsDirty(workspace.path);
  if (dirty && !input.archiveOnly) {
    return {
      removable: false,
      dirty,
      reason: "dirty",
      dirtySummary: workspaceDirtySummary(workspace.path),
    };
  }
  return { removable: true, dirty, reason: "ok" };
}

export async function removeWorkspaceImpl(
  deps: WorkspaceOpsDeps,
  input: RemoveWorkspaceInput,
): Promise<RemoveWorkspaceResult> {
  const workspace = deps.store.listWorkspaces().find((candidate) => candidate.id === input.workspaceId);
  if (!workspace) throw new Error(`Unknown workspace: ${input.workspaceId}`);
  const repo = deps.store.listRepos().find((candidate) => candidate.id === workspace.repoId);
  if (!repo) throw new Error(`Workspace repo is missing: ${workspace.repoId}`);
  if (workspace.kind === "root") {
    // The root workspace tracks the repo's main checkout; it can only be
    // removed by removing the repository itself.
    const operation = deps.operation(
      "workspace.remove",
      "failed",
      workspace.repoId,
      workspace.id,
      100,
      "Cannot drop the root workspace",
    );
    deps.store.upsertOperation({
      ...operation,
      error: "Root workspace is non-removable. Remove the repository to drop it.",
      updatedAt: nowIso(),
    });
    return { operationId: operation.id, removed: false, archived: false, dirty: false };
  }
  const operation = deps.operation(
    "workspace.remove",
    "running",
    workspace.repoId,
    workspace.id,
    10,
    "Checking workspace status",
  );
  const dirty = workspaceIsDirty(workspace.path);
  if (dirty && !input.force && !input.archiveOnly) {
    deps.store.updateWorkspaceLifecycle(workspace.id, "ready", true);
    deps.store.upsertOperation({
      ...operation,
      status: "failed",
      progress: 100,
      error: "Workspace has uncommitted changes. Use metadata archive or explicit force cleanup.",
      updatedAt: nowIso(),
    });
    deps.activity(
      "workspace.remove.blocked",
      "system",
      `Removal blocked because ${workspace.name} has dirty git status`,
      workspace.repoId,
      workspace.id,
      operation.id,
    );
    // Attach the actual change summary so the drop dialog can surface
    // exactly which files / commits are blocking. Bounded by the helper's
    // built-in caps (50 files, 20 commits).
    const dirtySummary = workspaceDirtySummary(workspace.path);
    return { operationId: operation.id, removed: false, archived: false, dirty, dirtySummary };
  }

  const ownedSessions = deps.store.listSessions(workspace.id);
  for (const session of ownedSessions) {
    if (session.tmuxSessionName && !input.archiveOnly)
      killTmuxSession(session.tmuxSessionName, session.tmuxSocketName ?? null);
  }
  if (ownedSessions.length && !input.archiveOnly) {
    deps.logOp(operation.id, "info", `Killed ${ownedSessions.length} tmux session(s) attached to workspace`);
  }

  const worktreeMissing = !input.archiveOnly && !fs.existsSync(workspace.path);
  if (!input.archiveOnly && !worktreeMissing) {
    try {
      deps.logOp(
        operation.id,
        "info",
        `Running ${repo.teardownHookIds.length} teardown hook(s): ${repo.teardownHookIds.join(", ") || "(none)"}`,
      );
      await deps.runWorkspaceHooks("workspace.teardown", repo.teardownHookIds, repo, workspace, operation.id);
    } catch (error) {
      if (!input.force) {
        deps.store.upsertOperation({
          ...operation,
          status: "failed",
          progress: 100,
          error: error instanceof Error ? error.message : "workspace_teardown_failed",
          updatedAt: nowIso(),
        });
        deps.activity(
          "workspace.remove.blocked",
          "system",
          `Removal blocked because teardown failed for ${workspace.name}`,
          workspace.repoId,
          workspace.id,
          operation.id,
        );
        return { operationId: operation.id, removed: false, archived: false, dirty };
      }
    }
  }

  if (!input.archiveOnly) {
    const cleanup = cleanupWorktree(repo.rootPath, workspace.path);
    deps.logOp(operation.id, "info", `${cleanup.action} worktree at ${workspace.path}`);
    if (cleanup.warning) deps.logOp(operation.id, "warn", `git worktree prune failed: ${cleanup.warning}`);
  }
  if (input.archiveOnly) {
    deps.store.archiveWorkspace(workspace.id, "archived", dirty);
    deps.logOp(operation.id, "info", `Marked workspace ${workspace.name} as archived`);
  } else {
    deps.store.deleteWorkspace(workspace.id);
    deps.logOp(operation.id, "info", `Deleted workspace ${workspace.name} (name slot freed)`);
  }
  deps.store.upsertOperation({
    ...operation,
    status: "succeeded",
    progress: 100,
    message: input.archiveOnly ? "Workspace metadata archived" : "Workspace removed",
    updatedAt: nowIso(),
  });
  deps.activity(
    input.archiveOnly ? "workspace.archived" : "workspace.removed",
    "user",
    input.archiveOnly ? `Archived ${workspace.name}` : `Removed ${workspace.name}`,
    workspace.repoId,
    workspace.id,
    operation.id,
  );
  await deps.runNotificationHooks(
    input.archiveOnly ? "workspace.archived" : "workspace.removed",
    repo,
    workspace,
    operation.id,
    { repo, workspace, result: { removed: !input.archiveOnly, archived: Boolean(input.archiveOnly), dirty } },
  );
  return { operationId: operation.id, removed: !input.archiveOnly, archived: Boolean(input.archiveOnly), dirty };
}
