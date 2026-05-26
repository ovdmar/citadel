// Workspace-level lifecycle operations extracted from OperationService to
// keep packages/operations/src/index.ts under the 800-line file-size gate
// (see scripts/checks/file-size.ts). Each function takes its store + helpers
// as a deps bag so the class stays the public surface and tests can stub.

import fs from "node:fs";
import type { HookConfig } from "@citadel/config";
import type { HookOutput, JiraAutoTransitionEvent, Operation, Repo, Workspace } from "@citadel/contracts";
import { nowIso } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import { killTmuxSession } from "@citadel/terminal";
import { cleanupWorktree, workspaceIsDirty } from "./helpers.js";

export type WorkspaceLifecycleDeps = {
  store: SqliteStore;
  newOperation: (
    type: string,
    status: Operation["status"],
    repoId: string | null,
    workspaceId: string | null,
    progress: number,
    message: string,
  ) => Operation;
  logOp: (operationId: string, level: "info" | "warn" | "error", message: string) => void;
  activity: (
    type: string,
    source: "user" | "system" | "hook",
    message: string,
    repoId: string | null,
    workspaceId: string | null,
    operationId: string | null,
    hookOutput?: HookOutput | null,
  ) => void;
  runWorkspaceHooks: (
    event: HookConfig["event"],
    hookIds: string[],
    repo: Repo,
    workspace: Workspace,
    operationId: string,
  ) => Promise<void>;
  runNotificationHooks: (
    event: HookConfig["event"],
    repo: Repo,
    workspace: Workspace,
    operationId: string | null,
    payload: unknown,
  ) => Promise<void>;
  runAutoTransitions?:
    | ((
        event: JiraAutoTransitionEvent,
        repo: Repo,
        workspace: Workspace,
        payload: { repo: Repo; workspace: Workspace },
      ) => Promise<void>)
    | null;
};

export type RemoveWorkspaceInput = { workspaceId: string; force?: boolean; archiveOnly?: boolean };
export type RemoveWorkspaceResult = { operationId: string; removed: boolean; archived: boolean; dirty: boolean };

export async function removeWorkspace(
  deps: WorkspaceLifecycleDeps,
  input: RemoveWorkspaceInput,
): Promise<RemoveWorkspaceResult> {
  const workspace = deps.store.listWorkspaces().find((candidate) => candidate.id === input.workspaceId);
  if (!workspace) throw new Error(`Unknown workspace: ${input.workspaceId}`);
  const repo = deps.store.listRepos().find((candidate) => candidate.id === workspace.repoId);
  if (!repo) throw new Error(`Workspace repo is missing: ${workspace.repoId}`);
  if (workspace.kind === "root") {
    const operation = deps.newOperation(
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
  const operation = deps.newOperation(
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
    return { operationId: operation.id, removed: false, archived: false, dirty };
  }

  const ownedSessions = deps.store.listSessions(workspace.id);
  for (const session of ownedSessions) {
    if (session.tmuxSessionName && !input.archiveOnly) killTmuxSession(session.tmuxSessionName);
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
  if (deps.runAutoTransitions) {
    try {
      await deps.runAutoTransitions(
        input.archiveOnly ? "workspace.archived" : "workspace.removed",
        repo,
        workspace,
        { repo, workspace },
      );
    } catch {
      // Logged inside the callback.
    }
  }
  return { operationId: operation.id, removed: !input.archiveOnly, archived: Boolean(input.archiveOnly), dirty };
}
