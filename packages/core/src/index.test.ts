import { describe, expect, it } from "vitest";
import {
  assertUniqueRepoPath,
  assertUniqueWorkspaceName,
  createId,
  parseRateLimitReason,
  repoDisplayName,
  sessionNeedsAttention,
  slugify,
  summarizeWorkspaceState,
  workspaceBranchName,
} from "./index.js";

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
    expect(slugify("!!!")).toBe("workspace");
    expect(repoDisplayName("/tmp/citadel")).toBe("citadel");
    expect(createId("ws")).toMatch(/^ws_[a-z0-9]+_[a-z0-9]+$/);
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
        kind: "worktree",
        prUrl: null,
        issueKey: null,
        issueTitle: null,
        issueUrl: null,
        slackThreadUrl: null,
        section: "review",
        pinned: true,
        lifecycle: "ready",
        dirty: false,
        namespaceId: null,
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

  it("moves unpinned workspaces to blocked or in-progress from session and provider signals", () => {
    const workspace = {
      id: "ws_test",
      repoId: "repo_test",
      name: "Task",
      path: "/tmp/task",
      branch: "task",
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
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
      archivedAt: null,
    } as const;

    expect(
      summarizeWorkspaceState({
        workspace,
        sessions: [
          {
            id: "sess_failed",
            workspaceId: "ws_test",
            runtimeId: "shell",
            displayName: "Shell",
            status: "failed",
            transport: "disconnected",
            tmuxSessionName: null,
            tmuxSessionId: null,
            createdAt: "2026-05-17T00:00:00.000Z",
            updatedAt: "2026-05-17T00:00:00.000Z",
          },
        ],
        providerHealth: [],
      }).suggestedSection,
    ).toBe("blocked");

    expect(
      summarizeWorkspaceState({
        workspace,
        sessions: [
          {
            id: "sess_running",
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
      }).suggestedSection,
    ).toBe("in-progress");

    expect(
      summarizeWorkspaceState({
        workspace,
        sessions: [],
        providerHealth: [
          {
            id: "github-gh",
            kind: "version-control",
            displayName: "GitHub CLI",
            status: "degraded",
            reason: "not authenticated",
            checkedAt: "2026-05-17T00:00:00.000Z",
          },
        ],
      }).reasons,
    ).toContain("Provider data is degraded or unavailable");
  });
});

describe("rate-limit status helpers", () => {
  it("parseRateLimitReason accepts the two canonical shapes and rejects everything else", () => {
    expect(parseRateLimitReason("rate_limited:2026-05-26T10:00:00.000Z")).toEqual({
      resetAt: "2026-05-26T10:00:00.000Z",
    });
    expect(parseRateLimitReason("rate_limited:unknown_reset")).toEqual({ resetAt: null });
    // Reject non-rate-limited prefixes.
    expect(parseRateLimitReason("pane:active:running")).toBeNull();
    expect(parseRateLimitReason("rate-limited:2026-05-26T10:00:00.000Z")).toBeNull();
    // Reject malformed ISO payload.
    expect(parseRateLimitReason("rate_limited:nonsense")).toBeNull();
    // Empty payload is malformed.
    expect(parseRateLimitReason("rate_limited:")).toBeNull();
  });

  it("sessionNeedsAttention is true for failed and tmux-gone unknown, false for rate_limited (own tone)", () => {
    const base = {
      statusReason: null,
    };
    // rate_limited has its own cit-pulse-info tone in the workspace card,
    // separate from the red attention tone reserved for hard failures.
    expect(sessionNeedsAttention({ ...base, status: "rate_limited" })).toBe(false);
    expect(sessionNeedsAttention({ ...base, status: "failed" })).toBe(true);
    expect(sessionNeedsAttention({ status: "unknown", statusReason: "tmux_missing" })).toBe(true);
    expect(sessionNeedsAttention({ status: "unknown", statusReason: "daemon_restart_indeterminate" })).toBe(false);
    expect(sessionNeedsAttention({ ...base, status: "idle" })).toBe(false);
    expect(sessionNeedsAttention({ ...base, status: "running" })).toBe(false);
  });
});

describe("uniqueness guards", () => {
  it("rejects active duplicate repo paths and workspace names while allowing archived records", () => {
    const repo = {
      id: "repo_test",
      name: "Repo",
      rootPath: "/tmp/repo",
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: "/tmp/worktrees",
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
      archivedAt: null,
    };
    const workspace = {
      id: "ws_test",
      repoId: repo.id,
      name: "Task",
      path: "/tmp/worktrees/task",
      branch: "task",
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
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
      archivedAt: null,
    } as const;

    expect(() => assertUniqueRepoPath([repo], "/tmp/repo")).toThrow("Repository already registered");
    expect(() => assertUniqueWorkspaceName([workspace], repo.id, "Task")).toThrow("Workspace name already exists");
    expect(() =>
      assertUniqueRepoPath([{ ...repo, archivedAt: "2026-05-17T00:00:00.000Z" }], "/tmp/repo"),
    ).not.toThrow();
    expect(() =>
      assertUniqueWorkspaceName([{ ...workspace, archivedAt: "2026-05-17T00:00:00.000Z" }], repo.id, "Task"),
    ).not.toThrow();
  });
});
