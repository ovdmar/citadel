import type { Repo, Workspace } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { SECTION_ORDER, buildGroupTree, collectGroupPaths } from "./navigator-groups.js";

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
    createdAt: ts,
    updatedAt: ts,
    archivedAt: null,
    ...overrides,
  };
}

describe("buildGroupTree", () => {
  const repoA = makeRepo("r-a", "alpha");
  const repoB = makeRepo("r-b", "bravo");
  const repos = [repoA, repoB];

  it("returns an empty tree when grouping is empty", () => {
    const ws = [makeWorkspace("w1", "r-a")];
    expect(buildGroupTree(ws, repos, [], [], undefined, [])).toEqual([]);
  });

  it("groups by repo and emits one leaf per repo with workspace counts", () => {
    const ws = [makeWorkspace("w1", "r-a"), makeWorkspace("w2", "r-b"), makeWorkspace("w3", "r-a")];
    const tree = buildGroupTree(ws, repos, [], [], undefined, ["repo"]);
    expect(tree.map((node) => ({ label: node.label, count: node.count, kind: node.kind }))).toEqual([
      { label: "alpha", count: 2, kind: "leaf" },
      { label: "bravo", count: 1, kind: "leaf" },
    ]);
    expect(tree[0]?.path).toBe("repo=alpha");
  });

  it("orders status groups by SECTION_ORDER, not alphabetically", () => {
    // Build workspaces that fall into different attention sections via the heuristic
    // in readinessForWorkspace (no summary, no operations): dirty → "dirty", default → "idle",
    // lifecycle=failed → "blocked".
    const dirty = makeWorkspace("w-dirty", "r-a", { dirty: true });
    const idle = makeWorkspace("w-idle", "r-a");
    const blocked = makeWorkspace("w-blocked", "r-a", { lifecycle: "failed" });
    const tree = buildGroupTree([idle, dirty, blocked], repos, [], [], undefined, ["status"]);
    const labels = tree.map((node) => node.label);
    expect(labels).toEqual(["Blocked", "Dirty", "Idle"]);
    // sanity: SECTION_ORDER puts blocked < dirty < idle
    expect(SECTION_ORDER.indexOf("blocked")).toBeLessThan(SECTION_ORDER.indexOf("dirty"));
    expect(SECTION_ORDER.indexOf("dirty")).toBeLessThan(SECTION_ORDER.indexOf("idle"));
  });

  it("places needs-review at its SECTION_ORDER slot when grouping by status", () => {
    // Regression: previously bucket keys were the formatted label ("Needs review"),
    // which didn't match SECTION_ORDER's hyphenated "needs-review" — needs-review
    // was sorted to the end as 'unknown'. Drive the section via a summary so the
    // readiness state maps to "needs-review".
    const wsNeedsReview = makeWorkspace("w-nr", "r-a");
    const wsIdle = makeWorkspace("w-idle", "r-a");
    const summary = {
      workspaceId: wsNeedsReview.id,
      readiness: { state: "needs-review", nextAction: "Review the diff", tone: "info" },
      versionControl: { pullRequest: null },
    } as unknown as Parameters<typeof buildGroupTree>[4];
    const tree = buildGroupTree([wsIdle, wsNeedsReview], repos, [], [], summary, ["status"]);
    expect(tree.map((node) => node.label)).toEqual(["Needs review", "Idle"]);
  });

  it("builds nested groups when multiple group keys are supplied", () => {
    const ws = [makeWorkspace("w1", "r-a"), makeWorkspace("w2", "r-a", { dirty: true }), makeWorkspace("w3", "r-b")];
    const tree = buildGroupTree(ws, repos, [], [], undefined, ["repo", "status"]);
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
    const tree = buildGroupTree([], repos, [], [], undefined, ["repo", "status"]);
    expect(tree).toEqual([]);
  });

  it("falls back to 'Unknown repo' when a workspace's repo is missing", () => {
    const orphan = makeWorkspace("w-orphan", "r-missing");
    const tree = buildGroupTree([orphan], repos, [], [], undefined, ["repo"]);
    expect(tree[0]?.label).toBe("Unknown repo");
  });
});

describe("collectGroupPaths", () => {
  it("returns every node path in the tree, including nested children", () => {
    const repos = [makeRepo("r-a", "alpha")];
    const ws = [makeWorkspace("w1", "r-a"), makeWorkspace("w2", "r-a", { dirty: true })];
    const tree = buildGroupTree(ws, repos, [], [], undefined, ["repo", "status"]);
    const paths = collectGroupPaths(tree);
    expect(paths.has("repo=alpha")).toBe(true);
    expect(paths.has("repo=alpha/status=dirty")).toBe(true);
    expect(paths.has("repo=alpha/status=idle")).toBe(true);
  });
});
