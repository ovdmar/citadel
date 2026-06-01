import path from "node:path";
import type { Workspace, WorktreeCheckout } from "@citadel/contracts";

export type WorkspaceLayoutMigrationSkipReason =
  | "already_migrated"
  | "active_session_or_operation"
  | "missing_path"
  | "not_git_worktree"
  | "target_collision"
  | "cross_device"
  | "git_worktree_move_unavailable";

export type WorkspaceLayoutMigrationPlan =
  | {
      action: "migrate";
      workspaceId: string;
      oldCheckoutPath: string;
      tempCheckoutPath: string;
      finalRootPath: string;
      finalCheckoutPath: string;
      checkoutName: string;
      manifestPath: string;
    }
  | { action: "skip"; workspaceId: string; reason: WorkspaceLayoutMigrationSkipReason };

export function planWorkspaceLayoutMigration(input: {
  workspace: Workspace;
  checkoutName: string;
  pathExists: (candidate: string) => boolean;
  isGitWorktree: (candidate: string) => boolean;
  sameDevice: (from: string, to: string) => boolean;
  hasActiveSessionOrOperation: boolean;
  gitWorktreeMoveAvailable: boolean;
}): WorkspaceLayoutMigrationPlan {
  const rootPath = input.workspace.rootPath ?? input.workspace.path;
  const oldCheckoutPath = input.workspace.path;
  const finalRootPath = oldCheckoutPath;
  const finalCheckoutPath = path.join(finalRootPath, input.checkoutName);
  if (rootPath !== oldCheckoutPath && oldCheckoutPath.startsWith(rootPath)) {
    return { action: "skip", workspaceId: input.workspace.id, reason: "already_migrated" };
  }
  if (input.hasActiveSessionOrOperation) {
    return { action: "skip", workspaceId: input.workspace.id, reason: "active_session_or_operation" };
  }
  if (!input.pathExists(oldCheckoutPath)) {
    return { action: "skip", workspaceId: input.workspace.id, reason: "missing_path" };
  }
  if (!input.isGitWorktree(oldCheckoutPath)) {
    return { action: "skip", workspaceId: input.workspace.id, reason: "not_git_worktree" };
  }
  if (input.pathExists(finalCheckoutPath)) {
    return { action: "skip", workspaceId: input.workspace.id, reason: "target_collision" };
  }
  if (!input.sameDevice(oldCheckoutPath, path.dirname(oldCheckoutPath))) {
    return { action: "skip", workspaceId: input.workspace.id, reason: "cross_device" };
  }
  if (!input.gitWorktreeMoveAvailable) {
    return { action: "skip", workspaceId: input.workspace.id, reason: "git_worktree_move_unavailable" };
  }
  return {
    action: "migrate",
    workspaceId: input.workspace.id,
    oldCheckoutPath,
    tempCheckoutPath: `${oldCheckoutPath}.citadel-migrating-${input.workspace.id}`,
    finalRootPath,
    finalCheckoutPath,
    checkoutName: input.checkoutName,
    manifestPath: path.join(path.dirname(oldCheckoutPath), `.citadel-migrate-${input.workspace.id}.json`),
  };
}

export type WorkspaceLayoutMigrationDeps = {
  writeManifest(
    plan: Extract<WorkspaceLayoutMigrationPlan, { action: "migrate" }>,
    snapshot: WorkspaceGitSnapshot,
  ): void;
  gitSnapshot(cwd: string): WorkspaceGitSnapshot;
  gitWorktreeMove(from: string, to: string): void;
  mkdirp(path: string): void;
  verifyFinalState(finalCheckoutPath: string, before: WorkspaceGitSnapshot): void;
  updateStore(workspace: Workspace, checkout: WorktreeCheckout): void;
};

export type WorkspaceGitSnapshot = {
  statusPorcelain: string;
  topLevel: string;
  commonDir: string;
  branch: string;
  head: string;
  worktreeList: string;
};

export function executeWorkspaceLayoutMigration(input: {
  plan: WorkspaceLayoutMigrationPlan;
  workspace: Workspace;
  checkout: WorktreeCheckout;
  deps: WorkspaceLayoutMigrationDeps;
}): { migrated: boolean; skipped?: WorkspaceLayoutMigrationSkipReason } {
  if (input.plan.action === "skip") return { migrated: false, skipped: input.plan.reason };
  const before = input.deps.gitSnapshot(input.plan.oldCheckoutPath);
  input.deps.writeManifest(input.plan, before);
  input.deps.gitWorktreeMove(input.plan.oldCheckoutPath, input.plan.tempCheckoutPath);
  input.deps.mkdirp(input.plan.finalRootPath);
  input.deps.gitWorktreeMove(input.plan.tempCheckoutPath, input.plan.finalCheckoutPath);
  input.deps.verifyFinalState(input.plan.finalCheckoutPath, before);
  input.deps.updateStore(
    { ...input.workspace, rootPath: input.plan.finalRootPath, path: input.plan.oldCheckoutPath },
    { ...input.checkout, path: input.plan.finalCheckoutPath, name: input.plan.checkoutName },
  );
  return { migrated: true };
}
