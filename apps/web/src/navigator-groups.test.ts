import type { Operation, Repo, Workspace } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import {
  SECTION_ORDER,
  buildGroupTree,
  collectGroupPaths,
  findGroupPathForWorkspace,
  flattenWorkspaceOrder,
  treeGroupingFor,
} from "./navigator-groups.js";

const ts = "2026-01-01T00:00:00.000Z";

function makeRepo(id: string, name: string): Repo {
  return {
    id,
    name,
    rootPath: `/repos/${id}`,
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: `/repos/${id}/.wt`,
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: [],
    deployHookCommand: null,
    createdAt: ts,
    updatedAt: ts,
    archivedAt: null,
  };
}

function makeWorkspace(id: string, repoId: string, overrides: Partial<Workspace> = {}): Workspace {
  return {
    id,
    repoId,
    name: id,
    path: `/wt/${id}`,
    branch: `feat/${id}`,
    baseBranch: "main",
    source: "scratch",
    kind: "worktree",
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
    createdAt: ts,
    updatedAt: ts,
    archivedAt: null,
    ...overrides,
  };
}

function makeFailedOp(workspaceId: string): Operation {
  return {
    id: `op-${workspaceId}`,
    workspaceId,
    repoId: null,
    type: "workspace.create",
    status: "failed",
    summary: "synthetic",
    failureReason: null,
    metadata: {},
    createdAt: ts,
    updatedAt: ts,
    startedAt: ts,
    finishedAt: ts,
  } as unknown as Operation;
}

describe("buildGroupTree", () => {
  const repoA = makeRepo("r-a", "alpha");
  const repoB = makeRepo("r-b", "bravo");
  const repos = [repoA, repoB];

  it("returns an empty tree when grouping is empty", () => {
    const ws = [makeWorkspace("w1", "r-a")];
    expect(buildGroupTree(ws, repos, [], [], [])).toEqual([]);
  });

  it("groups by repo and emits one leaf per repo with workspace counts", () => {
    const ws = [makeWorkspace("w1", "r-a"), makeWorkspace("w2", "r-b"), makeWorkspace("w3", "r-a")];
    const tree = buildGroupTree(ws, repos, [], [], ["repo"]);
    expect(tree.map((node) => ({ label: node.label, count: node.count, kind: node.kind }))).toEqual([
      { label: "alpha", count: 2, kind: "leaf" },
      { label: "bravo", count: 1, kind: "leaf" },
    ]);
    expect(tree[0]?.path).toBe("repo=alpha");
  });

  it("orders status groups by SECTION_ORDER, not alphabetically", () => {
    // readinessForWorkspace (without summary): dirty → "dirty", default → "idle",
    // lifecycle=failed → "blocked".
    const dirty = makeWorkspace("w-dirty", "r-a", { dirty: true });
    const idle = makeWorkspace("w-idle", "r-a");
    const blocked = makeWorkspace("w-blocked", "r-a", { lifecycle: "failed" });
    const tree = buildGroupTree([idle, dirty, blocked], repos, [], [], ["status"]);
    expect(tree.map((node) => node.label)).toEqual(["Blocked", "Dirty", "Idle"]);
    expect(SECTION_ORDER.indexOf("blocked")).toBeLessThan(SECTION_ORDER.indexOf("dirty"));
    expect(SECTION_ORDER.indexOf("dirty")).toBeLessThan(SECTION_ORDER.indexOf("idle"));
  });

  it("derives the blocked section from a failed operation", () => {
    const ws = makeWorkspace("w1", "r-a");
    const tree = buildGroupTree([ws], repos, [], [makeFailedOp(ws.id)], ["status"]);
    expect(tree.map((node) => node.label)).toEqual(["Blocked"]);
  });

  it("builds nested groups when multiple group keys are supplied", () => {
    const ws = [makeWorkspace("w1", "r-a"), makeWorkspace("w2", "r-a", { dirty: true }), makeWorkspace("w3", "r-b")];
    const tree = buildGroupTree(ws, repos, [], [], ["repo", "status"]);
    expect(tree).toHaveLength(2);
    const alpha = tree[0];
    expect(alpha?.kind).toBe("group");
    expect(alpha?.label).toBe("alpha");
    expect(alpha?.count).toBe(2);
    if (alpha?.kind !== "group") throw new Error("expected group node");
    expect(alpha.children.map((child) => child.label)).toEqual(["Dirty", "Idle"]);
    expect(alpha.children[0]?.path).toBe("repo=alpha/status=dirty");
  });

  it("skips empty groups", () => {
    const tree = buildGroupTree([], repos, [], [], ["repo", "status"]);
    expect(tree).toEqual([]);
  });

  it("falls back to 'Unknown repo' when a workspace's repo is missing", () => {
    const orphan = makeWorkspace("w-orphan", "r-missing");
    const tree = buildGroupTree([orphan], repos, [], [], ["repo"]);
    expect(tree[0]?.label).toBe("Unknown repo");
  });
});

describe("treeGroupingFor", () => {
  it("uses workspace-root rendering for the default workspace grouping", () => {
    expect(treeGroupingFor("workspace")).toEqual([]);
  });

  it("keeps namespace grouping nested below repo", () => {
    expect(treeGroupingFor("namespace")).toEqual(["repo", "namespace"]);
  });
});

describe("collectGroupPaths", () => {
  it("returns every node path in the tree, including nested children", () => {
    const repos = [makeRepo("r-a", "alpha")];
    const ws = [makeWorkspace("w1", "r-a"), makeWorkspace("w2", "r-a", { dirty: true })];
    const tree = buildGroupTree(ws, repos, [], [], ["repo", "status"]);
    const paths = collectGroupPaths(tree);
    expect(paths.has("repo=alpha")).toBe(true);
    expect(paths.has("repo=alpha/status=dirty")).toBe(true);
    expect(paths.has("repo=alpha/status=idle")).toBe(true);
  });
});

describe("flattenWorkspaceOrder", () => {
  const repoA = makeRepo("r-a", "alpha");
  const repoB = makeRepo("r-b", "bravo");
  const repos = [repoA, repoB];

  it("returns an empty list for an empty tree (grouping = none)", () => {
    expect(flattenWorkspaceOrder([])).toEqual([]);
  });

  it("walks leaves in depth-first tree order, regardless of collapse state", () => {
    const ws = [makeWorkspace("w1", "r-a"), makeWorkspace("w2", "r-b"), makeWorkspace("w3", "r-a")];
    const tree = buildGroupTree(ws, repos, [], [], ["repo"]);
    // Repo grouping orders by repo name (alpha, bravo). Within each leaf,
    // workspaces appear in their input order.
    expect(flattenWorkspaceOrder(tree)).toEqual(["w1", "w3", "w2"]);
  });

  it("walks nested groups depth-first (repo → status)", () => {
    const dirty = makeWorkspace("w-dirty", "r-a", { dirty: true });
    const idle = makeWorkspace("w-idle", "r-a");
    const otherIdle = makeWorkspace("w-bravo-idle", "r-b");
    const tree = buildGroupTree([idle, dirty, otherIdle], repos, [], [], ["repo", "status"]);
    // Within repo=alpha: status order is dirty before idle (per SECTION_ORDER).
    expect(flattenWorkspaceOrder(tree)).toEqual(["w-dirty", "w-idle", "w-bravo-idle"]);
  });
});

describe("findGroupPathForWorkspace", () => {
  const repoA = makeRepo("r-a", "alpha");
  const repoB = makeRepo("r-b", "bravo");
  const repos = [repoA, repoB];

  it("returns null when the tree is empty (grouping = none)", () => {
    expect(findGroupPathForWorkspace([], "w1")).toBeNull();
  });

  it("returns null when the workspace is not found in the tree", () => {
    const tree = buildGroupTree([makeWorkspace("w1", "r-a")], repos, [], [], ["repo"]);
    expect(findGroupPathForWorkspace(tree, "missing")).toBeNull();
  });

  it("returns the leaf path containing the workspace (single-level grouping)", () => {
    const tree = buildGroupTree([makeWorkspace("w1", "r-a"), makeWorkspace("w2", "r-b")], repos, [], [], ["repo"]);
    expect(findGroupPathForWorkspace(tree, "w2")).toBe("repo=bravo");
  });

  it("returns the deepest enclosing leaf path (two-level grouping)", () => {
    const dirty = makeWorkspace("w-dirty", "r-a", { dirty: true });
    const idle = makeWorkspace("w-idle", "r-a");
    const tree = buildGroupTree([dirty, idle], repos, [], [], ["repo", "status"]);
    expect(findGroupPathForWorkspace(tree, "w-dirty")).toBe("repo=alpha/status=dirty");
    expect(findGroupPathForWorkspace(tree, "w-idle")).toBe("repo=alpha/status=idle");
  });
});
