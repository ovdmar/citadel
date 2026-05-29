import fs from "node:fs";
import type { ActivityEvent, Operation } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { killTmuxSession } from "@citadel/terminal";
import { nowIso } from "@citadel/core";
import { tryRunGit } from "./helpers.js";

type ActivityFn = (
  type: string,
  source: ActivityEvent["source"],
  message: string,
  repoId: string | null,
  workspaceId: string | null,
  operationId: string | null,
) => void;

type NewOperationFn = (
  type: string,
  status: Operation["status"],
  repoId: string | null,
  workspaceId: string | null,
  progress: number,
  message: string,
) => Operation;

export type RemoveRepoDeps = {
  store: SqliteStore;
  activity: ActivityFn;
  operation: NewOperationFn;
};

export function removeRepo(
  deps: RemoveRepoDeps,
  input: { repoId: string; force?: boolean; cleanupWorktrees?: boolean },
) {
  const { store, activity, operation: newOperation } = deps;
  const repo = store.listRepos().find((candidate) => candidate.id === input.repoId);
  if (!repo) throw new Error(`Unknown repo: ${input.repoId}`);
  const workspaces = store.listWorkspaces(repo.id);
  const sessions = store
    .listSessions()
    .filter((session) => workspaces.some((workspace) => workspace.id === session.workspaceId));
  const activeSessions = sessions.filter((session) =>
    ["starting", "running", "waiting_for_input", "rate_limited", "usage_limited", "idle"].includes(session.status),
  );
  const runningOperations = store
    .listOperations()
    .filter((operation) => operation.repoId === repo.id && ["queued", "running"].includes(operation.status));
  const operation = newOperation(
    "repo.remove",
    "running",
    repo.id,
    null,
    10,
    input.cleanupWorktrees ? "Checking repository cleanup impact" : "Archiving repository metadata",
  );

  if (!input.force && (activeSessions.length || runningOperations.length)) {
    store.upsertOperation({
      ...operation,
      status: "failed",
      progress: 100,
      error: `Repository has ${activeSessions.length} active sessions and ${runningOperations.length} running operations. Confirm removal to continue.`,
      updatedAt: nowIso(),
    });
    activity(
      "repo.remove.blocked",
      "system",
      `Removal blocked for ${repo.name}; active sessions or operations exist`,
      repo.id,
      null,
      operation.id,
    );
    return {
      operationId: operation.id,
      removed: false,
      archivedWorkspaces: 0,
      cleanupWorktrees: Boolean(input.cleanupWorktrees),
      activeSessions: activeSessions.length,
      runningOperations: runningOperations.length,
    };
  }

  for (const session of sessions) {
    if (session.tmuxSessionName && input.cleanupWorktrees) killTmuxSession(session.tmuxSessionName);
  }

  let cleanedWorktrees = 0;
  if (input.cleanupWorktrees) {
    for (const workspace of workspaces) {
      if (!fs.existsSync(workspace.path)) continue;
      try {
        tryRunGit(repo.rootPath, ["worktree", "remove", "--force", workspace.path]);
        cleanedWorktrees += 1;
      } catch (error) {
        if (!input.force) {
          const message = error instanceof Error ? error.message : "repo_cleanup_failed";
          store.upsertOperation({
            ...operation,
            status: "failed",
            progress: 100,
            error: message,
            updatedAt: nowIso(),
          });
          activity(
            "repo.remove.blocked",
            "system",
            `Cleanup failed while removing ${repo.name}: ${message}`,
            repo.id,
            null,
            operation.id,
          );
          return {
            operationId: operation.id,
            removed: false,
            archivedWorkspaces: 0,
            cleanupWorktrees: true,
            cleanedWorktrees,
            activeSessions: activeSessions.length,
            runningOperations: runningOperations.length,
          };
        }
      }
    }
  }

  store.archiveRepo(repo.id);
  store.upsertOperation({
    ...operation,
    status: "succeeded",
    progress: 100,
    message: input.cleanupWorktrees
      ? `Repository removed and ${cleanedWorktrees} worktrees cleaned up`
      : "Repository removed from Citadel tracking; worktrees preserved",
    updatedAt: nowIso(),
  });
  activity(
    "repo.removed",
    "user",
    input.cleanupWorktrees
      ? `Removed ${repo.name} and cleaned ${cleanedWorktrees} worktrees`
      : `Removed ${repo.name} from tracking and preserved worktrees`,
    repo.id,
    null,
    operation.id,
  );
  return {
    operationId: operation.id,
    removed: true,
    archivedWorkspaces: workspaces.length,
    cleanupWorktrees: Boolean(input.cleanupWorktrees),
    cleanedWorktrees,
    activeSessions: activeSessions.length,
    runningOperations: runningOperations.length,
  };
}
