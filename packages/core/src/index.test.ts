import type { AgentSession, PullRequestSummary } from "@citadel/contracts";
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

  it("returns false for normal running status", () => {
    for (const status of ["running"] as const) {
      expect(sessionNeedsAttention({ status, statusReason: null })).toBe(false);
    }
  });

  it("returns true for blocked statuses", () => {
    for (const status of ["waiting_for_input", "rate_limited", "usage_limited"] as const) {
      expect(sessionNeedsAttention({ status, statusReason: null })).toBe(true);
    }
  });
});

import {
  assertUniqueRepoPath,
  assertUniqueWorkspaceName,
  createId,
  deriveAgentLifecycleTone,
  deriveWorkspaceLifecycleTone,
  repoDisplayName,
  slugify,
  summarizeWorkspaceState,
  workspaceBranchName,
} from "./index.js";

function makeAgent(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "sess_x",
    workspaceId: "ws_x",
    runtimeId: "claude-code",
    displayName: "Claude",
    status: "running",
    transport: "connected",
    tmuxSessionName: "citadel_x",
    tmuxSessionId: "$1",
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    ...overrides,
  };
}

function makePr(overrides: Partial<PullRequestSummary> = {}): PullRequestSummary {
  return {
    number: 1,
    title: "WIP",
    url: "https://example/pr/1",
    state: "OPEN",
    draft: false,
    reviewDecision: null,
    checks: [],
    additions: null,
    deletions: null,
    reviewers: [],
    commits: [],
    headRefName: null,
    parentPr: null,
    mergeable: "unknown",
    allowedMergeStrategies: [],
    mergeStateStatus: null,
    headSha: null,
    ...overrides,
  };
}

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

describe("deriveAgentLifecycleTone", () => {
  it("maps active lifecycle states to running", () => {
    expect(deriveAgentLifecycleTone(makeAgent({ status: "starting" }))).toBe("running");
    expect(deriveAgentLifecycleTone(makeAgent({ status: "running" }))).toBe("running");
  });

  it("maps plain idle to done and crashed idle to attention", () => {
    expect(deriveAgentLifecycleTone(makeAgent({ status: "idle" }))).toBe("done");
    expect(deriveAgentLifecycleTone(makeAgent({ status: "idle", statusReason: "idle_after_unexpected_exit" }))).toBe(
      "attention",
    );
  });

  it("maps waiting_for_input to attention", () => {
    expect(deriveAgentLifecycleTone(makeAgent({ status: "waiting_for_input" }))).toBe("attention");
  });

  it("maps rate_limited and usage_limited to attention", () => {
    expect(deriveAgentLifecycleTone(makeAgent({ status: "rate_limited" }))).toBe("attention");
    expect(deriveAgentLifecycleTone(makeAgent({ status: "usage_limited" }))).toBe("attention");
  });

  it("treats clean and operator-initiated stops as done", () => {
    expect(deriveAgentLifecycleTone(makeAgent({ status: "stopped", exitCode: 0 }))).toBe("done");
    expect(deriveAgentLifecycleTone(makeAgent({ status: "stopped", exitCode: null }))).toBe("done");
    expect(deriveAgentLifecycleTone(makeAgent({ status: "stopped", exitCode: 130 }))).toBe("done");
    expect(deriveAgentLifecycleTone(makeAgent({ status: "stopped", exitCode: 143 }))).toBe("done");
  });

  it("treats genuinely failed exit codes as attention", () => {
    expect(deriveAgentLifecycleTone(makeAgent({ status: "stopped", exitCode: 1 }))).toBe("attention");
    expect(deriveAgentLifecycleTone(makeAgent({ status: "stopped", exitCode: 127 }))).toBe("attention");
  });

  it("maps failed to attention", () => {
    expect(deriveAgentLifecycleTone(makeAgent({ status: "failed" }))).toBe("attention");
  });

  it("classifies unknown by status reason", () => {
    expect(deriveAgentLifecycleTone(makeAgent({ status: "unknown", statusReason: "tmux_missing" }))).toBe("attention");
    expect(
      deriveAgentLifecycleTone(makeAgent({ status: "unknown", statusReason: "sentinel_missing_tmux_alive" })),
    ).toBe("attention");
    expect(deriveAgentLifecycleTone(makeAgent({ status: "unknown", statusReason: "migrated_from_orphaned" }))).toBe(
      "attention",
    );
    expect(
      deriveAgentLifecycleTone(makeAgent({ status: "unknown", statusReason: "daemon_restart_indeterminate" })),
    ).toBe("running");
    expect(deriveAgentLifecycleTone(makeAgent({ status: "unknown", statusReason: null }))).toBe("running");
  });

  it("never returns never-started at the per-agent layer", () => {
    const allStatuses: AgentSession["status"][] = [
      "starting",
      "running",
      "waiting_for_input",
      "rate_limited",
      "usage_limited",
      "idle",
      "stopped",
      "failed",
      "unknown",
    ];
    for (const status of allStatuses) {
      const tone = deriveAgentLifecycleTone(makeAgent({ status }));
      expect(tone).not.toBe("never-started");
    }
  });
});

describe("deriveWorkspaceLifecycleTone", () => {
  it("never-started when no agent sessions are present", () => {
    expect(deriveWorkspaceLifecycleTone({ sessions: [] })).toBe("never-started");
  });

  it("never-started when only shell sessions are present", () => {
    expect(
      deriveWorkspaceLifecycleTone({
        sessions: [makeAgent({ runtimeId: "shell", status: "running" })],
      }),
    ).toBe("never-started");
  });

  it("running when at least one agent is active and no failures", () => {
    expect(
      deriveWorkspaceLifecycleTone({
        sessions: [makeAgent({ status: "running" })],
      }),
    ).toBe("running");
  });

  it("rate-limited and usage-limited map to attention", () => {
    expect(
      deriveWorkspaceLifecycleTone({
        sessions: [makeAgent({ id: "a", status: "running" }), makeAgent({ id: "b", status: "rate_limited" })],
      }),
    ).toBe("attention");
    expect(
      deriveWorkspaceLifecycleTone({
        sessions: [makeAgent({ id: "a", status: "usage_limited" }), makeAgent({ id: "b", status: "running" })],
      }),
    ).toBe("attention");
  });

  it("attention wins over running across agents", () => {
    expect(
      deriveWorkspaceLifecycleTone({
        sessions: [makeAgent({ id: "a", status: "failed" }), makeAgent({ id: "b", status: "running" })],
      }),
    ).toBe("attention");
  });

  it("done when all agents finished cleanly and no PR", () => {
    expect(
      deriveWorkspaceLifecycleTone({
        sessions: [makeAgent({ status: "stopped", exitCode: 0 })],
      }),
    ).toBe("done");
  });

  it("done when all agents finished and PR checks all success", () => {
    expect(
      deriveWorkspaceLifecycleTone({
        sessions: [makeAgent({ status: "stopped", exitCode: 0 })],
        pullRequest: makePr({
          checks: [
            { name: "ci", status: "completed", conclusion: "success", url: null, startedAt: null, completedAt: null },
          ],
        }),
      }),
    ).toBe("done");
  });

  it("attention when PR has any failure-class check (override agent aggregate)", () => {
    expect(
      deriveWorkspaceLifecycleTone({
        sessions: [makeAgent({ status: "stopped", exitCode: 0 })],
        pullRequest: makePr({
          checks: [
            { name: "ok", status: "completed", conclusion: "success", url: null, startedAt: null, completedAt: null },
            { name: "ci", status: "completed", conclusion: "failure", url: null, startedAt: null, completedAt: null },
          ],
        }),
      }),
    ).toBe("attention");
  });

  it("running agent + failing PR still escalates to attention", () => {
    expect(
      deriveWorkspaceLifecycleTone({
        sessions: [makeAgent({ status: "running" })],
        pullRequest: makePr({
          checks: [
            { name: "ci", status: "completed", conclusion: "failure", url: null, startedAt: null, completedAt: null },
          ],
        }),
      }),
    ).toBe("attention");
  });

  it("empty PR checks does not override agent aggregate", () => {
    expect(
      deriveWorkspaceLifecycleTone({
        sessions: [makeAgent({ status: "stopped", exitCode: 0 })],
        pullRequest: makePr({ checks: [] }),
      }),
    ).toBe("done");
  });

  it("pending PR check (conclusion null) does not override done", () => {
    expect(
      deriveWorkspaceLifecycleTone({
        sessions: [makeAgent({ status: "stopped", exitCode: 0 })],
        pullRequest: makePr({
          checks: [
            { name: "ci", status: "in_progress", conclusion: null, url: null, startedAt: null, completedAt: null },
          ],
        }),
      }),
    ).toBe("done");
  });

  it("PR conflict escalates to attention", () => {
    expect(
      deriveWorkspaceLifecycleTone({
        sessions: [makeAgent({ status: "stopped", exitCode: 0 })],
        pullRequest: makePr({ mergeable: "conflicting" }),
      }),
    ).toBe("attention");
    expect(
      deriveWorkspaceLifecycleTone({
        sessions: [makeAgent({ status: "stopped", exitCode: 0 })],
        pullRequest: makePr({ mergeStateStatus: "DIRTY" }),
      }),
    ).toBe("attention");
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
