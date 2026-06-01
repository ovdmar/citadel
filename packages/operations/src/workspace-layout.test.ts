import type { Workspace, WorktreeCheckout } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { executionTargetCwd, resolveExecutionTargetForCwd, workspaceRootPath } from "./workspace-layout.js";

const workspace: Workspace = {
  id: "ws_1",
  repoId: null,
  name: "Feature",
  path: "/work/feature",
  rootPath: "/work/feature",
  mode: "structured",
  branch: "home",
  baseBranch: "main",
  source: "scratch",
  kind: "root",
  lifecyclePhase: "implementation",
  prUrl: null,
  issueKey: null,
  issueTitle: null,
  issueUrl: null,
  slackThreadUrl: null,
  section: "backlog",
  pinned: false,
  lifecycle: "ready",
  dirty: false,
  namespaceId: null,
  createdAt: "2026-06-01T00:00:00.000Z",
  updatedAt: "2026-06-01T00:00:00.000Z",
  archivedAt: null,
};

const checkout: WorktreeCheckout = {
  id: "co_1",
  workspaceId: "ws_1",
  repoId: "repo_1",
  name: "api",
  path: "/work/feature/api",
  branch: "feature/api",
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

describe("workspace layout helpers", () => {
  it("selects root and checkout cwd explicitly", () => {
    expect(workspaceRootPath(workspace)).toBe("/work/feature");
    expect(executionTargetCwd({ workspace, targetType: "workspace_home" })).toBe("/work/feature");
    expect(executionTargetCwd({ workspace, checkout, targetType: "worktree_checkout" })).toBe("/work/feature/api");
  });

  it("resolves cwd most-specific-first and rejects escapes", () => {
    const realpath = (candidate: string) => candidate.replace("/link", "/work");
    expect(
      resolveExecutionTargetForCwd({
        cwd: "/work/feature/api/src",
        workspaces: [workspace],
        checkouts: [checkout],
        realpath,
      }),
    ).toMatchObject({ ok: true, target: { type: "worktree_checkout", checkoutId: "co_1" } });
    expect(
      resolveExecutionTargetForCwd({
        cwd: "/link/feature/docs",
        workspaces: [workspace],
        checkouts: [checkout],
        realpath,
      }),
    ).toMatchObject({ ok: true, target: { type: "workspace_home", workspaceId: "ws_1" } });
    expect(
      resolveExecutionTargetForCwd({
        cwd: "/work/feature-other",
        workspaces: [workspace],
        checkouts: [checkout],
        realpath,
      }),
    ).toEqual({ ok: false, error: "outside_registered_workspace" });
  });
});
