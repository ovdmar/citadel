import type { Workspace, WorktreeCheckout } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import {
  type WorkspaceGitSnapshot,
  executeWorkspaceLayoutMigration,
  planWorkspaceLayoutMigration,
} from "./workspace-layout-migration.js";

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
        pathExists: (candidate) => candidate !== "/work/feature/repo",
        isGitWorktree: () => true,
        sameDevice: () => false,
        hasActiveSessionOrOperation: false,
        gitWorktreeMoveAvailable: true,
      }),
    ).toEqual({ action: "skip", workspaceId: "ws_1", reason: "cross_device" });
  });
});
