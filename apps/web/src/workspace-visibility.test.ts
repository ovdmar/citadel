import type { Repo, Workspace } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { visibleNavigatorWorkspaces } from "./workspace-visibility.js";

const ts = "2026-05-26T00:00:00.000Z";

describe("visibleNavigatorWorkspaces", () => {
  it("hides main repo workspaces by default and keeps structured Homes visible", () => {
    const repo = makeRepo({ id: "repo_a", showMainWorkspace: false });
    const mainRepo = makeWorkspace({ id: "ws_main", repoId: repo.id, kind: "root", name: "main" });
    const structuredHome = makeWorkspace({
      id: "ws_home",
      repoId: null,
      kind: "root",
      mode: "structured",
      name: "Feature Home",
    });

    expect(visibleNavigatorWorkspaces([mainRepo, structuredHome], [repo]).map((workspace) => workspace.id)).toEqual([
      "ws_home",
    ]);
    expect(
      visibleNavigatorWorkspaces([mainRepo, structuredHome], [{ ...repo, showMainWorkspace: true }]).map(
        (workspace) => workspace.id,
      ),
    ).toEqual(["ws_main", "ws_home"]);
  });
});

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: "repo_a",
    name: "citadel",
    rootPath: "/repo/citadel",
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: "/worktrees",
    providerRepositoryKey: "ovdmar/citadel",
    showMainWorkspace: false,
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: [],
    deployHookCommand: null,
    createdAt: ts,
    updatedAt: ts,
    archivedAt: null,
    ...overrides,
  };
}

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_a",
    repoId: "repo_a",
    name: "Test",
    path: "/tmp/test",
    rootPath: "/tmp/test",
    branch: "main",
    baseBranch: "main",
    source: "imported",
    kind: "root",
    prUrl: null,
    issueKey: null,
    issueTitle: null,
    issueUrl: null,
    slackThreadUrl: null,
    section: "backlog",
    pinned: true,
    lifecycle: "ready",
    dirty: false,
    namespaceId: null,
    createdAt: ts,
    updatedAt: ts,
    archivedAt: null,
    ...overrides,
  };
}
