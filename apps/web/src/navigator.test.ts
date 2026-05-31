import type { AgentSession, PullRequestSummary, Workspace } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { aggregateNavigatorTone } from "./navigator.js";

function makeWorkspace(over: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws_a",
    repoId: "repo_a",
    name: "Test",
    path: "/tmp/test",
    branch: "feature/test",
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
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    archivedAt: null,
    ...over,
  };
}

function makeAgent(over: Partial<AgentSession> = {}): AgentSession {
  return {
    id: "sess_a",
    workspaceId: "ws_a",
    runtimeId: "claude-code",
    displayName: "Claude",
    status: "running",
    transport: "connected",
    tmuxSessionName: "citadel_a",
    tmuxSessionId: "$1",
    createdAt: "2026-05-26T00:00:00.000Z",
    updatedAt: "2026-05-26T00:00:00.000Z",
    ...over,
  };
}

function makePr(over: Partial<PullRequestSummary> = {}): PullRequestSummary {
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
    ...over,
  };
}

describe("aggregateNavigatorTone", () => {
  it("never-started when no workspaces are passed", () => {
    expect(aggregateNavigatorTone([], [], undefined)).toBe("never-started");
  });

  it("never-started when workspaces exist but have no agent sessions", () => {
    expect(aggregateNavigatorTone([makeWorkspace({ id: "w1" })], [], undefined)).toBe("never-started");
  });

  it("running when one workspace has a running agent and no PR fold", () => {
    expect(
      aggregateNavigatorTone(
        [makeWorkspace({ id: "w1" })],
        [makeAgent({ workspaceId: "w1", status: "running" })],
        undefined,
      ),
    ).toBe("running");
  });

  it("done when every workspace's agents finished and no PR overrides", () => {
    expect(
      aggregateNavigatorTone(
        [makeWorkspace({ id: "w1" }), makeWorkspace({ id: "w2" })],
        [
          makeAgent({ id: "a", workspaceId: "w1", status: "stopped", exitCode: 0 }),
          makeAgent({ id: "b", workspaceId: "w2", status: "stopped", exitCode: 0 }),
        ],
        undefined,
      ),
    ).toBe("done");
  });

  it("running wins over done across workspaces", () => {
    expect(
      aggregateNavigatorTone(
        [makeWorkspace({ id: "w1" }), makeWorkspace({ id: "w2" })],
        [
          makeAgent({ id: "a", workspaceId: "w1", status: "running" }),
          makeAgent({ id: "b", workspaceId: "w2", status: "stopped", exitCode: 0 }),
        ],
        undefined,
      ),
    ).toBe("running");
  });

  it("attention short-circuits over both running and done", () => {
    expect(
      aggregateNavigatorTone(
        [makeWorkspace({ id: "w1" }), makeWorkspace({ id: "w2" }), makeWorkspace({ id: "w3" })],
        [
          makeAgent({ id: "a", workspaceId: "w1", status: "stopped", exitCode: 0 }),
          makeAgent({ id: "b", workspaceId: "w2", status: "running" }),
          makeAgent({ id: "c", workspaceId: "w3", status: "failed" }),
        ],
        undefined,
      ),
    ).toBe("attention");
  });

  it("PR with a failing check on one workspace escalates the global tone to attention", () => {
    const map = new Map<string, PullRequestSummary | null>();
    map.set(
      "w1",
      makePr({
        checks: [
          { name: "ci", status: "completed", conclusion: "failure", url: null, startedAt: null, completedAt: null },
        ],
      }),
    );
    expect(
      aggregateNavigatorTone(
        [makeWorkspace({ id: "w1" }), makeWorkspace({ id: "w2" })],
        [
          makeAgent({ id: "a", workspaceId: "w1", status: "running" }),
          makeAgent({ id: "b", workspaceId: "w2", status: "stopped", exitCode: 0 }),
        ],
        map,
      ),
    ).toBe("attention");
  });

  it("PR conflict on one workspace escalates the global tone to attention", () => {
    const map = new Map<string, PullRequestSummary | null>();
    map.set("w1", makePr({ mergeable: "conflicting" }));
    expect(
      aggregateNavigatorTone(
        [makeWorkspace({ id: "w1" }), makeWorkspace({ id: "w2" })],
        [
          makeAgent({ id: "a", workspaceId: "w1", status: "stopped", exitCode: 0 }),
          makeAgent({ id: "b", workspaceId: "w2", status: "stopped", exitCode: 0 }),
        ],
        map,
      ),
    ).toBe("attention");
  });

  it("missing workspacePullRequests is treated as 'no fold' (degrades safely)", () => {
    // Same inputs as the running+passing-CI case, but no PR map at all → still running.
    expect(
      aggregateNavigatorTone(
        [makeWorkspace({ id: "w1" })],
        [makeAgent({ workspaceId: "w1", status: "running" })],
        undefined,
      ),
    ).toBe("running");
  });
});
