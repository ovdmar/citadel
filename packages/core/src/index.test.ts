import { describe, expect, it } from "vitest";
import { slugify, summarizeWorkspaceState, workspaceBranchName } from "./index.js";

describe("workspace naming", () => {
  it("creates issue-backed branch names with issue key and dashified title", () => {
    expect(
      workspaceBranchName({
        source: "issue",
        name: "ignored",
        issueKey: "ms-123",
        issueTitle: "Fix provider health states",
      }),
    ).toBe("MS-123-fix-provider-health-states");
  });

  it("falls back to a safe workspace slug", () => {
    expect(slugify("Review: terminal + resize!")).toBe("review-terminal-resize");
  });
});

describe("workspace state summary", () => {
  it("keeps pinned workspaces in their current section", () => {
    const result = summarizeWorkspaceState({
      workspace: {
        id: "ws_test",
        repoId: "repo_test",
        name: "Pinned",
        path: "/tmp/pinned",
        branch: "pinned",
        baseBranch: "main",
        source: "scratch",
        prUrl: null,
        issueKey: null,
        issueTitle: null,
        section: "review",
        pinned: true,
        lifecycle: "ready",
        dirty: false,
        createdAt: "2026-05-17T00:00:00.000Z",
        updatedAt: "2026-05-17T00:00:00.000Z",
        archivedAt: null,
      },
      sessions: [
        {
          id: "sess_test",
          workspaceId: "ws_test",
          runtimeId: "shell",
          displayName: "Shell",
          status: "running",
          transport: "connected",
          tmuxSessionName: "citadel_test",
          tmuxSessionId: "$1",
          createdAt: "2026-05-17T00:00:00.000Z",
          updatedAt: "2026-05-17T00:00:00.000Z",
        },
      ],
      providerHealth: [],
    });

    expect(result.suggestedSection).toBe("review");
    expect(result.reasons).toContain("Pinned by operator");
  });
});
