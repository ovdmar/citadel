import { describe, expect, it } from "vitest";
import { sessionNeedsAttention } from "./index.js";

describe("sessionNeedsAttention (shell-first attention predicate)", () => {
  it("returns true for status='idle' with statusReason='idle_after_unexpected_exit' (crashed agent signal)", () => {
    expect(sessionNeedsAttention({ status: "idle", statusReason: "idle_after_unexpected_exit" })).toBe(true);
  });

  it("returns false for status='idle' with statusReason=null (user-initiated Ctrl+C / Restart cleared the label)", () => {
    expect(sessionNeedsAttention({ status: "idle", statusReason: null })).toBe(false);
  });

  it("preserves the existing unknown-with-tmux_missing path (still attention-worthy)", () => {
    expect(sessionNeedsAttention({ status: "unknown", statusReason: "tmux_missing" })).toBe(true);
    expect(sessionNeedsAttention({ status: "unknown", statusReason: "sentinel_missing_tmux_alive" })).toBe(true);
    expect(sessionNeedsAttention({ status: "unknown", statusReason: "migrated_from_orphaned" })).toBe(true);
  });

  it("preserves the existing daemon_restart_indeterminate path (NOT attention-worthy)", () => {
    expect(sessionNeedsAttention({ status: "unknown", statusReason: "daemon_restart_indeterminate" })).toBe(false);
  });

  it("preserves the existing status='failed' (always attention)", () => {
    expect(sessionNeedsAttention({ status: "failed", statusReason: null })).toBe(true);
  });

  it("returns false for normal living statuses (running / waiting_for_input / rate_limited / usage_limited)", () => {
    for (const status of ["running", "waiting_for_input", "rate_limited", "usage_limited"] as const) {
      expect(sessionNeedsAttention({ status, statusReason: null })).toBe(false);
    }
  });
});

import {
  assertUniqueRepoPath,
  assertUniqueWorkspaceName,
  createId,
  repoDisplayName,
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
          kind: "terminal",
          workspaceId: "ws_test",
          runtimeId: null,
          displayName: "Terminal",
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
            kind: "agent",
            workspaceId: "ws_test",
            runtimeId: "claude-code",
            displayName: "Claude Code",
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
            kind: "agent",
            workspaceId: "ws_test",
            runtimeId: "codex",
            displayName: "Codex",
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
        sessions: [
          {
            id: "sess_terminal",
            kind: "terminal",
            workspaceId: "ws_test",
            runtimeId: null,
            displayName: "Terminal",
            status: "running",
            transport: "connected",
            tmuxSessionName: "citadel_terminal",
            tmuxSessionId: "$2",
            createdAt: "2026-05-17T00:00:00.000Z",
            updatedAt: "2026-05-17T00:00:00.000Z",
          },
        ],
        providerHealth: [],
      }).suggestedSection,
    ).toBe("backlog");

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
