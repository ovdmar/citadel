import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { HookConfig } from "@citadel/config";
import type { HookDiagnostic, HookOutput, Operation, Repo, Workspace } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";
import { hookDiagnostic } from "@citadel/hooks";
import { tmuxSessionExists } from "@citadel/terminal";

export function asObject(payload: unknown) {
  return typeof payload === "object" && payload !== null ? payload : {};
}

export function discoverDefaultBranch(rootPath: string) {
  try {
    const remoteHead = execFileSync("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      cwd: rootPath,
      encoding: "utf8",
    })
      .trim()
      .replace("refs/remotes/origin/", "");
    return remoteHead || "main";
  } catch {
    return "main";
  }
}

export function tryRunGit(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

export function workspaceIsDirty(workspacePath: string) {
  if (!fs.existsSync(workspacePath)) return false;
  const output = execFileSync("git", ["status", "--porcelain=v1"], {
    cwd: workspacePath,
    encoding: "utf8",
    maxBuffer: 512 * 1024,
  });
  return output.trim().length > 0;
}

export function withActionHookIds(output: HookOutput, hookId: string): HookOutput {
  return {
    ...output,
    actions: output.actions.map((action) => ({ ...action, hookId: action.hookId ?? hookId })),
  };
}

/**
 * Walk the local SqliteStore and reconcile it with disk reality:
 *  - mark sessions as `orphaned` (or delete) when their tmux session is gone
 *  - mark workspaces whose worktree directory no longer exists as `failed`
 *  - archive repos whose rootPath no longer exists.
 */
export function reconcileStore(
  store: SqliteStore,
  activity: (message: string, repoId: string | null) => void,
): { sessions: number; workspaces: number; repos: number; deletedSessions: number } {
  let sessionCount = 0;
  let workspaceCount = 0;
  let repoCount = 0;
  let deletedSessions = 0;
  for (const session of store.listSessions()) {
    if (!session.tmuxSessionName) continue;
    if (["stopped", "orphaned", "failed"].includes(session.status)) continue;
    if (!tmuxSessionExists(session.tmuxSessionName)) {
      const workspaceExists = store.listWorkspaces().some((workspace) => workspace.id === session.workspaceId);
      if (!workspaceExists) {
        store.deleteSession(session.id);
        deletedSessions += 1;
      } else {
        store.updateSessionStatus(session.id, "orphaned");
      }
      sessionCount += 1;
    }
  }
  for (const workspace of store.listWorkspaces()) {
    if (workspace.lifecycle === "ready" && !fs.existsSync(workspace.path)) {
      store.updateWorkspaceLifecycle(workspace.id, "failed");
      workspaceCount += 1;
    }
  }
  for (const repo of store.listRepos()) {
    if (!fs.existsSync(path.join(repo.rootPath, ".git"))) {
      store.archiveRepo(repo.id);
      activity(`Auto-archived ${repo.name} (rootPath missing)`, repo.id);
      repoCount += 1;
    }
  }
  return { sessions: sessionCount, workspaces: workspaceCount, repos: repoCount, deletedSessions };
}

export function listHookDiagnostics(input: {
  repo: Repo;
  workspace?: Workspace | null | undefined;
  hooks: HookConfig[];
  appHookIds: string[];
  actionHookIds: string[];
  hookTimeoutMs: number;
}): HookDiagnostic[] {
  const events: Array<HookConfig["event"]> = [
    "workspace.setup",
    "workspace.teardown",
    "workspace.apps",
    "workspace.action",
  ];
  return events.flatMap((event) => {
    const ids =
      event === "workspace.setup"
        ? input.repo.setupHookIds
        : event === "workspace.teardown"
          ? input.repo.teardownHookIds
          : event === "workspace.apps"
            ? input.appHookIds
            : input.actionHookIds;
    const eventHooks = input.hooks.filter((hook) => hook.event === event);
    const filtered = ids.length ? eventHooks.filter((hook) => ids.includes(hook.id)) : eventHooks;
    return filtered.map((hook) =>
      hookDiagnostic({
        hook: {
          id: hook.id,
          event: hook.event,
          command: hook.command,
          args: hook.args,
          cwd: hook.cwd || input.workspace?.path || input.repo.rootPath,
          timeoutMs: input.hookTimeoutMs,
          blocking: hook.blocking,
        },
        enabled: true,
      }),
    );
  });
}

export function cancelOperationInStore(
  store: SqliteStore,
  operationId: string,
  nowIso: () => string,
): { cancelled: boolean; reason: "not_found" | "not_cancellable" | "ok"; operation: Operation | null } {
  const operation = store.findOperation(operationId);
  if (!operation) return { cancelled: false, reason: "not_found", operation: null };
  if (!["queued", "running"].includes(operation.status))
    return { cancelled: false, reason: "not_cancellable", operation };
  const updated: Operation = {
    ...operation,
    status: "cancelled",
    progress: 100,
    message: operation.message ?? "Operation cancelled",
    updatedAt: nowIso(),
  };
  store.upsertOperation(updated);
  return { cancelled: true, reason: "ok", operation: updated };
}
