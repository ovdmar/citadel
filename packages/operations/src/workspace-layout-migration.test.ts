import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Workspace, WorktreeCheckout } from "@citadel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../../db/src/index.js";
import { OperationService } from "./index.js";
import {
  type WorkspaceGitSnapshot,
  executeWorkspaceLayoutMigration,
  planWorkspaceLayoutMigration,
} from "./workspace-layout-migration.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const workspace: Workspace = {
  id: "ws_1",
  repoId: "repo_1",
  name: "Feature",
  path: "/work/feature",
  rootPath: "/work/feature",
  mode: "freestyle",
  branch: "feature",
  baseBranch: "main",
  source: "scratch",
  kind: "worktree",
  lifecyclePhase: "implementation",
  prUrl: null,
  issueKey: null,
  issueTitle: null,
  issueUrl: null,
  slackThreadUrl: null,
  section: "backlog",
  pinned: false,
  lifecycle: "ready",
  dirty: true,
  namespaceId: null,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  archivedAt: null,
};

const checkout: WorktreeCheckout = {
  id: "co_1",
  workspaceId: "ws_1",
  repoId: "repo_1",
  name: "feature",
  path: "/work/feature",
  branch: "feature",
  baseBranch: "main",
  issue: null,
  intendedPr: null,
  stackParentCheckoutId: null,
  inferredPurpose: "implementation",
  gateStatus: "not_started",
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  archivedAt: null,
};

const snapshot: WorkspaceGitSnapshot = {
  statusPorcelain: " M src/app.ts\n?? notes.md\n",
  topLevel: "/work/feature",
  commonDir: "/repo/.git/worktrees/feature",
  branch: "feature",
  head: "abc123",
  worktreeList: "worktree /work/feature\n",
};

describe("workspace layout migration planner", () => {
  it("plans the git worktree move sequence and keeps dirty status verifiable", () => {
    const plan = planWorkspaceLayoutMigration({
      workspace,
      checkoutName: "repo",
      pathExists: (candidate) => candidate === "/work/feature",
      isGitWorktree: () => true,
      sameDevice: () => true,
      hasActiveSessionOrOperation: false,
      gitWorktreeMoveAvailable: true,
    });
    expect(plan).toMatchObject({
      action: "migrate",
      oldCheckoutPath: "/work/feature",
      tempCheckoutPath: "/work/feature.citadel-migrating-ws_1",
      finalRootPath: "/work/feature",
      finalCheckoutPath: "/work/feature/repo",
    });

    const calls: string[] = [];
    const result = executeWorkspaceLayoutMigration({
      plan,
      workspace,
      checkout,
      deps: {
        gitSnapshot: () => snapshot,
        writeManifest: () => calls.push("manifest"),
        gitWorktreeMove: (from, to) => calls.push(`move:${from}->${to}`),
        mkdirp: (target) => calls.push(`mkdir:${target}`),
        verifyFinalState: (target, before) => calls.push(`verify:${target}:${before.statusPorcelain}`),
        updateStore: (updatedWorkspace, updatedCheckout) =>
          calls.push(`store:${updatedWorkspace.rootPath}:${updatedCheckout.path}`),
      },
    });

    expect(result).toEqual({ migrated: true });
    expect(calls).toEqual([
      "manifest",
      "move:/work/feature->/work/feature.citadel-migrating-ws_1",
      "mkdir:/work/feature",
      "move:/work/feature.citadel-migrating-ws_1->/work/feature/repo",
      "verify:/work/feature/repo: M src/app.ts\n?? notes.md\n",
      "store:/work/feature:/work/feature/repo",
    ]);
  });

  it("skips unsafe automatic migrations", () => {
    expect(
      planWorkspaceLayoutMigration({
        workspace,
        checkoutName: "repo",
        pathExists: () => true,
        isGitWorktree: () => true,
        sameDevice: () => true,
        hasActiveSessionOrOperation: true,
        gitWorktreeMoveAvailable: true,
      }),
    ).toEqual({ action: "skip", workspaceId: "ws_1", reason: "active_session_or_operation" });
    expect(
      planWorkspaceLayoutMigration({
        workspace,
        checkoutName: "repo",
        pathExists: (candidate) => candidate === "/work/feature",
        isGitWorktree: () => true,
        sameDevice: () => false,
        hasActiveSessionOrOperation: false,
        gitWorktreeMoveAvailable: true,
      }),
    ).toEqual({ action: "skip", workspaceId: "ws_1", reason: "cross_device" });
  });

  it("runs the boot migration with git worktree move and preserves dirty files", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-layout-migration-"));
    dirs.push(dir);
    const repoPath = path.join(dir, "repo");
    const worktreeParent = path.join(dir, "worktrees");
    const worktreePath = path.join(worktreeParent, "feature");
    fs.mkdirSync(repoPath, { recursive: true });
    fs.mkdirSync(worktreeParent, { recursive: true });
    git(repoPath, ["init", "-b", "main"]);
    git(repoPath, ["config", "user.email", "test@example.test"]);
    git(repoPath, ["config", "user.name", "Citadel Test"]);
    fs.writeFileSync(path.join(repoPath, "README.md"), "initial\n");
    git(repoPath, ["add", "README.md"]);
    git(repoPath, ["commit", "-m", "initial"]);
    git(repoPath, ["worktree", "add", "-b", "feature/layout", worktreePath, "main"]);
    fs.writeFileSync(path.join(worktreePath, "dirty.txt"), "dirty\n");

    const timestamp = "2026-06-01T00:00:00.000Z";
    const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
    store.migrate();
    store.insertRepo({
      id: "repo_1",
      name: "Repo",
      rootPath: repoPath,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent,
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    });
    store.insertWorkspace({
      id: "ws_1",
      repoId: "repo_1",
      name: "Feature",
      path: worktreePath,
      rootPath: worktreePath,
      mode: "freestyle",
      branch: "feature/layout",
      baseBranch: "main",
      source: "scratch",
      kind: "worktree",
      lifecyclePhase: "implementation",
      prUrl: null,
      issueKey: null,
      issueTitle: null,
      issueUrl: null,
      slackThreadUrl: null,
      section: "backlog",
      pinned: false,
      lifecycle: "ready",
      dirty: true,
      namespaceId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    });
    store.insertWorkspaceCheckout({
      id: "co_1",
      workspaceId: "ws_1",
      repoId: "repo_1",
      name: "repo",
      path: worktreePath,
      branch: "feature/layout",
      baseBranch: "main",
      issue: null,
      intendedPr: null,
      stackParentCheckoutId: null,
      inferredPurpose: "implementation",
      gateStatus: "not_started",
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    });

    const result = new OperationService(store).runWorkspaceLayoutMigrations();
    const finalCheckoutPath = path.join(worktreePath, "repo");

    expect(result).toMatchObject({ migrated: 1, skipped: [] });
    expect(fs.existsSync(path.join(worktreePath, ".citadel-migrate-ws_1.json"))).toBe(false);
    expect(fs.existsSync(path.join(worktreeParent, ".citadel-migrate-ws_1.json"))).toBe(true);
    expect(store.listWorkspaceCheckouts("ws_1")).toMatchObject([{ id: "co_1", path: finalCheckoutPath }]);
    expect(store.listWorkspaces().find((entry) => entry.id === "ws_1")).toMatchObject({
      path: worktreePath,
      rootPath: worktreePath,
    });
    expect(git(finalCheckoutPath, ["status", "--porcelain=v1"])).toContain("?? dirty.txt");
    expect(git(finalCheckoutPath, ["rev-parse", "--show-toplevel"])).toBe(finalCheckoutPath);
  });
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trimEnd();
}
