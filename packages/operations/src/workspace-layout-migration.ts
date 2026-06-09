import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Repo, Workspace, WorktreeCheckout } from "@citadel/contracts";
import type { SqliteStore } from "@citadel/db";

export type WorkspaceLayoutMigrationSkipReason =
  | "already_migrated"
  | "not_citadel_worktree"
  | "active_session_or_operation"
  | "missing_path"
  | "not_git_worktree"
  | "target_collision"
  | "cross_device"
  | "git_worktree_move_unavailable"
  | "git_state_invalid"
  | "migration_failed";

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
  if (input.pathExists(`${oldCheckoutPath}.citadel-migrating-${input.workspace.id}`)) {
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

export type WorkspaceLayoutMigrationRunSummary = {
  considered: number;
  migrated: number;
  skipped: Array<{ workspaceId: string; reason: WorkspaceLayoutMigrationSkipReason; detail?: string }>;
};

const ACTIVE_SESSION_STATUSES = new Set([
  "starting",
  "running",
  "waiting_for_input",
  "rate_limited",
  "usage_limited",
  "idle",
]);
const ACTIVE_OPERATION_STATUSES = new Set(["queued", "running"]);

export function hasWorkspaceLayoutMigrationCandidates(store: SqliteStore): boolean {
  return store.listWorkspaces().some((workspace) => {
    if (!isLegacyWorktreeWorkspace(workspace)) return false;
    return store.listWorkspaceCheckouts(workspace.id).length > 0;
  });
}

export function runWorkspaceLayoutMigrations(input: {
  store: SqliteStore;
  log?: (level: "info" | "warn" | "error", message: string) => void;
}): WorkspaceLayoutMigrationRunSummary {
  const repos = input.store.listRepos();
  const workspaces = input.store.listWorkspaces();
  const operations = input.store.listOperations();
  const summary: WorkspaceLayoutMigrationRunSummary = { considered: 0, migrated: 0, skipped: [] };

  for (const workspace of workspaces) {
    const candidate = migrationCandidate(input.store, repos, operations, workspace);
    if (candidate.skip) {
      if (candidate.counted) {
        summary.considered += 1;
        const skipped: WorkspaceLayoutMigrationRunSummary["skipped"][number] = {
          workspaceId: workspace.id,
          reason: candidate.reason,
        };
        if (candidate.detail !== undefined) skipped.detail = candidate.detail;
        summary.skipped.push(skipped);
        input.log?.("warn", `Skipped workspace layout migration for ${workspace.name}: ${candidate.reason}`);
      }
      continue;
    }
    summary.considered += 1;
    if (candidate.kind === "promote_only") {
      try {
        const legacyCheckout = singleCheckoutForLegacySessions(candidate.checkouts);
        input.store.promoteLegacyWorkspaceToStructuredHome(workspace.id, {
          checkoutIdForLegacySessions: legacyCheckout?.id ?? null,
        });
        summary.migrated += 1;
        input.log?.("info", `Promoted legacy workspace ${workspace.name} to structured Home`);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        summary.skipped.push({ workspaceId: workspace.id, reason: "migration_failed", detail });
        input.log?.("error", `Workspace layout migration failed for ${workspace.name}: ${detail}`);
      }
      continue;
    }
    const { repo, checkout, hasActiveSessionOrOperation } = candidate;
    const checkoutName = checkoutNameForMigration(workspace, checkout);
    const plan = planWorkspaceLayoutMigration({
      workspace,
      checkoutName,
      pathExists: fs.existsSync,
      isGitWorktree,
      sameDevice,
      hasActiveSessionOrOperation,
      gitWorktreeMoveAvailable: gitWorktreeMoveAvailable(repo.rootPath),
    });
    if (plan.action === "skip") {
      summary.skipped.push({ workspaceId: workspace.id, reason: plan.reason });
      input.log?.("warn", `Skipped workspace layout migration for ${workspace.name}: ${plan.reason}`);
      continue;
    }
    try {
      executeWorkspaceLayoutMigration({
        plan,
        workspace,
        checkout,
        deps: {
          gitSnapshot,
          gitWorktreeMove: (from, to) => git(repo.rootPath, ["worktree", "move", from, to]),
          mkdirp: (target) => fs.mkdirSync(target, { recursive: true }),
          verifyFinalState,
          writeManifest,
          updateStore: (updatedWorkspace, updatedCheckout) => {
            input.store.updateWorkspaceLayout(updatedWorkspace.id, {
              path: updatedWorkspace.path,
              rootPath: updatedWorkspace.rootPath ?? updatedWorkspace.path,
              mode: updatedWorkspace.mode,
            });
            input.store.updateWorkspaceCheckoutLayout(updatedCheckout.id, {
              name: updatedCheckout.name,
              path: updatedCheckout.path,
            });
            input.store.promoteLegacyWorkspaceToStructuredHome(updatedWorkspace.id, {
              checkoutIdForLegacySessions: updatedCheckout.id,
            });
          },
        },
      });
      summary.migrated += 1;
      input.log?.("info", `Migrated workspace layout for ${workspace.name} to ${plan.finalCheckoutPath}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      summary.skipped.push({ workspaceId: workspace.id, reason: "migration_failed", detail });
      input.log?.("error", `Workspace layout migration failed for ${workspace.name}: ${detail}`);
    }
  }
  return summary;
}

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

type Candidate =
  | {
      skip: false;
      kind: "move_and_promote";
      repo: Repo;
      checkout: WorktreeCheckout;
      hasActiveSessionOrOperation: boolean;
    }
  | {
      skip: false;
      kind: "promote_only";
      checkouts: WorktreeCheckout[];
    }
  | {
      skip: true;
      counted: boolean;
      reason: WorkspaceLayoutMigrationSkipReason;
      detail?: string;
    };

function migrationCandidate(
  store: SqliteStore,
  repos: Repo[],
  operations: Array<{ workspaceId: string | null; status: string }>,
  workspace: Workspace,
): Candidate {
  if (!isLegacyWorktreeWorkspace(workspace)) {
    return { skip: true, counted: false, reason: "not_citadel_worktree" };
  }
  const repo = repos.find((candidate) => candidate.id === workspace.repoId);
  const checkouts = store.listWorkspaceCheckouts(workspace.id);
  const checkout = checkouts.find((candidate) => samePath(candidate.path, workspace.path));
  if (!repo || !checkout) {
    if (checkouts.length > 0) return { skip: false, kind: "promote_only", checkouts };
    return { skip: true, counted: false, reason: "not_citadel_worktree" };
  }
  const hasActiveSessionOrOperation =
    store.listWorkspaceSessions(workspace.id).some((session) => ACTIVE_SESSION_STATUSES.has(session.status)) ||
    operations.some(
      (operation) => operation.workspaceId === workspace.id && ACTIVE_OPERATION_STATUSES.has(operation.status),
    );
  return { skip: false, kind: "move_and_promote", repo, checkout, hasActiveSessionOrOperation };
}

function isLegacyWorktreeWorkspace(workspace: Workspace): boolean {
  return Boolean(workspace.repoId) && workspace.kind === "worktree" && workspace.source !== "imported";
}

function singleCheckoutForLegacySessions(checkouts: WorktreeCheckout[]): WorktreeCheckout | null {
  const live = checkouts.filter((checkout) => !checkout.archivedAt);
  return live.length === 1 ? (live[0] ?? null) : null;
}

function writeManifest(
  plan: Extract<WorkspaceLayoutMigrationPlan, { action: "migrate" }>,
  snapshot: WorkspaceGitSnapshot,
) {
  fs.writeFileSync(
    plan.manifestPath,
    `${JSON.stringify({ version: 1, plan, snapshot, startedAt: new Date().toISOString() }, null, 2)}\n`,
  );
}

function gitSnapshot(cwd: string): WorkspaceGitSnapshot {
  return {
    statusPorcelain: git(cwd, ["status", "--porcelain=v1"]),
    topLevel: git(cwd, ["rev-parse", "--show-toplevel"]),
    commonDir: git(cwd, ["rev-parse", "--git-common-dir"]),
    branch: git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
    head: git(cwd, ["rev-parse", "HEAD"]),
    worktreeList: git(cwd, ["worktree", "list", "--porcelain"]),
  };
}

function verifyFinalState(finalCheckoutPath: string, before: WorkspaceGitSnapshot) {
  if (!fs.existsSync(path.join(finalCheckoutPath, ".git"))) throw new Error("gitdir_missing_after_move");
  const after = gitSnapshot(finalCheckoutPath);
  if (!samePath(after.topLevel, finalCheckoutPath)) throw new Error("top_level_mismatch_after_move");
  if (after.statusPorcelain !== before.statusPorcelain) throw new Error("status_changed_after_move");
  if (normalizeGitPath(finalCheckoutPath, after.commonDir) !== normalizeGitPath(before.topLevel, before.commonDir)) {
    throw new Error("common_dir_changed_after_move");
  }
  if (after.branch !== before.branch) throw new Error("branch_changed_after_move");
  if (after.head !== before.head) throw new Error("head_changed_after_move");
  if (!worktreeListIncludes(after.worktreeList, finalCheckoutPath)) throw new Error("worktree_list_missing_final_path");
}

function isGitWorktree(candidate: string): boolean {
  try {
    const dotGit = path.join(candidate, ".git");
    return fs.statSync(dotGit).isFile() && samePath(git(candidate, ["rev-parse", "--show-toplevel"]), candidate);
  } catch {
    return false;
  }
}

function sameDevice(from: string, to: string): boolean {
  try {
    return fs.statSync(from).dev === fs.statSync(to).dev;
  } catch {
    return false;
  }
}

function gitWorktreeMoveAvailable(cwd: string): boolean {
  const output = gitAllowFailure(cwd, ["worktree", "-h"]);
  return output.includes("git worktree move");
}

function checkoutNameForMigration(workspace: Workspace, checkout: WorktreeCheckout): string {
  const raw = checkout.name.trim() || path.basename(workspace.path) || "checkout";
  const segment = raw.replace(/[\\/]/g, "-").trim();
  return !segment || segment === "." || segment === ".." ? "checkout" : segment;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15_000,
  }).trimEnd();
}

function gitAllowFailure(cwd: string, args: string[]): string {
  try {
    return git(cwd, args);
  } catch (error) {
    const output = error as { stdout?: unknown; stderr?: unknown };
    return `${String(output.stdout ?? "")}\n${String(output.stderr ?? "")}`;
  }
}

function normalizeGitPath(cwd: string, candidate: string): string {
  return path.resolve(cwd, candidate);
}

function worktreeListIncludes(worktreeList: string, finalCheckoutPath: string): boolean {
  return worktreeList
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .some((line) => samePath(line.slice("worktree ".length), finalCheckoutPath));
}

function samePath(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}
