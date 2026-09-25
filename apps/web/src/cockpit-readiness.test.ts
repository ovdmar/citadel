import type { AgentSession, Operation, Workspace, WorkspaceSession } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { readinessForWorkspace, readinessSection } from "./cockpit-readiness.js";

const baseWorkspace: Workspace = {
  id: "ws_demo",
  repoId: "repo_demo",
  name: "demo",
  path: "/tmp/demo",
  branch: "demo",
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
  createdAt: "2026-05-23T00:00:00.000Z",
  updatedAt: "2026-05-23T00:00:00.000Z",
  archivedAt: null,
};

describe("readinessForWorkspace", () => {
  // Regression: previously this function could derive the section from the
  // per-workspace cockpit-summary readiness when it was supplied. That made the
  // active workspace's nav-rail section flip between "Blocked" (when summary
  // had loaded and contained e.g. waiting-provider / checks-failing) and
  // "Idle" (when summary was absent or focus moved), because the local rules
  // don't consider PR checks or provider health. Section is now always derived
  // from /api/state inputs only so the same workspace lands in the same
  // section regardless of whether the cockpit-summary has loaded.
  it("does not flip section when only /api/state inputs change reference but not value", () => {
    const sessions: WorkspaceSession[] = [];
    const operations: Operation[] = [];
    const first = readinessForWorkspace(baseWorkspace, { sessions, operations });
    // Simulate the next poll: fresh array references, identical contents.
    const second = readinessForWorkspace(
      { ...baseWorkspace },
      { sessions: [...sessions], operations: [...operations] },
    );
    expect(first.section).toBe("idle");
    expect(second.section).toBe(first.section);
  });

  it("classifies a workspace with a failed/orphaned session as blocked", () => {
    const sessions: AgentSession[] = [
      {
        id: "sess_x",
        workspaceId: baseWorkspace.id,
        kind: "agent",
        runtimeId: "claude-code",
        displayName: "Claude",
        status: "unknown",
        statusReason: "tmux_missing",
        transport: "disconnected",
        terminalBackend: "tmux",
        tmuxSessionName: null,
        tmuxSessionId: null,
        createdAt: baseWorkspace.createdAt,
        updatedAt: baseWorkspace.updatedAt,
      },
    ];
    expect(readinessForWorkspace(baseWorkspace, { sessions, operations: [] }).section).toBe("blocked");
  });

  it("classifies a workspace with a running operation as working", () => {
    const operations: Operation[] = [
      {
        id: "op_run",
        type: "workspace.action",
        status: "running",
        repoId: baseWorkspace.repoId,
        workspaceId: baseWorkspace.id,
        progress: 25,
        message: "Doing work",
        error: null,
        logs: [],
        retriable: false,
        retryInput: null,
        createdAt: baseWorkspace.createdAt,
        updatedAt: baseWorkspace.updatedAt,
      },
    ];
    expect(readinessForWorkspace(baseWorkspace, { sessions: [], operations }).section).toBe("working");
  });

  it("treats dirty workspaces as dirty when no failures or active work", () => {
    expect(readinessForWorkspace({ ...baseWorkspace, dirty: true }, { sessions: [], operations: [] }).section).toBe(
      "dirty",
    );
  });

  it("returns the same section for identical inputs across repeated calls (flicker repro)", () => {
    // Two consecutive query results carrying the *same* data — section must
    // be stable, otherwise the nav rail will re-bucket the workspace and the
    // card visibly jumps between sections every poll/SSE invalidation.
    const sessions: AgentSession[] = [
      {
        id: "sess_running",
        workspaceId: baseWorkspace.id,
        kind: "agent",
        runtimeId: "claude-code",
        displayName: "Claude",
        status: "running",
        transport: "connected",
        terminalBackend: "tmux",
        tmuxSessionName: "citadel_demo",
        tmuxSessionId: "$0",
        createdAt: baseWorkspace.createdAt,
        updatedAt: baseWorkspace.updatedAt,
      },
    ];
    const operations: Operation[] = [];
    const first = readinessForWorkspace(baseWorkspace, { sessions, operations });
    const second = readinessForWorkspace(baseWorkspace, {
      sessions: sessions.map((session) => ({ ...session })),
      operations: [...operations],
    });
    expect(second.section).toBe(first.section);
  });
});

describe("readinessSection", () => {
  it("maps richer daemon states into the five nav buckets", () => {
    expect(readinessSection("blocked")).toBe("blocked");
    expect(readinessSection("checks-failing")).toBe("blocked");
    expect(readinessSection("waiting-provider")).toBe("blocked");
    expect(readinessSection("needs-review")).toBe("needs-review");
    expect(readinessSection("ready-to-merge")).toBe("needs-review");
    expect(readinessSection("dirty")).toBe("dirty");
    expect(readinessSection("working")).toBe("working");
    expect(readinessSection("idle")).toBe("idle");
    expect(readinessSection("anything-else")).toBe("idle");
  });
});
