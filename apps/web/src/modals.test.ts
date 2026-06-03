import { describe, expect, it } from "vitest";
import { __testing__ } from "./add-repo-modal.js";
import { resolveCreateWorkspaceContext } from "./modals.js";

const { pathCompletionSelection } = __testing__;

describe("add repo path completion", () => {
  it("selects git repositories instead of drilling into them", () => {
    expect(pathCompletionSelection({ path: "/home/me/project", isGit: true })).toEqual({
      value: "/home/me/project",
      keepOpen: false,
    });
  });

  it("keeps navigating through ordinary directories", () => {
    expect(pathCompletionSelection({ path: "/home/me/projects", isGit: false })).toEqual({
      value: "/home/me/projects/",
      keepOpen: true,
    });
  });
});

describe("resolveCreateWorkspaceContext", () => {
  it("creates workspace Homes by default", () => {
    expect(resolveCreateWorkspaceContext(undefined, ["workspace"])).toBe("workspace-home");
    expect(resolveCreateWorkspaceContext({ kind: "auto" }, ["namespace", "workspace"])).toBe("workspace-home");
  });

  it("creates repo worktrees when repository grouping is active", () => {
    expect(resolveCreateWorkspaceContext({ kind: "auto" }, ["repo"])).toBe("repo-worktree");
    expect(resolveCreateWorkspaceContext({ kind: "auto" }, ["repo", "status"])).toBe("repo-worktree");
  });

  it("uses attach mode when opened from a workspace Home", () => {
    expect(
      resolveCreateWorkspaceContext({ kind: "attach-worktree", workspaceId: "ws_1", workspaceName: "Home" }, ["repo"]),
    ).toBe("attach-worktree");
  });
});
