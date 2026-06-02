import type { Workspace } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { type StateResponse, applyOptimisticRemoveFilter } from "./app-state.js";

function workspace(id: string): Workspace {
  return {
    id,
    repoId: "repo_a",
    name: id,
    path: `/tmp/${id}`,
    branch: id,
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
    createdAt: "2026-05-25T12:00:00.000Z",
    updatedAt: "2026-05-25T12:00:00.000Z",
    archivedAt: null,
  } as Workspace;
}

function baseState(workspaces: Workspace[]): StateResponse {
  return {
    repos: [],
    workspaces,
    checkouts: [],
    workspacePlans: [],
    workspacePlanDeliveryUnits: [],
    workspacePlanDependencyEdges: [],
    workspaceManagers: [],
    managerActions: [],
    localNotifications: [],
    planDeviations: [],
    sessions: [],
    operations: [],
    activity: [],
    providerHealth: [],
    agentRuntimes: [],
    terminal: { displayName: "Terminal", command: "bash", args: ["-l"] },
    mcp: { enabled: false, resources: [], tools: [] },
    scheduledAgents: [],
    namespaces: [],
    bootRestore: null,
  };
}

describe("applyOptimisticRemoveFilter", () => {
  it("returns the same reference when state is undefined", () => {
    expect(applyOptimisticRemoveFilter(undefined, new Set(["a"]))).toBeUndefined();
  });

  it("returns the same reference when the blacklist is empty", () => {
    // Identity-stable to avoid downstream re-renders when no drop is in flight.
    const state = baseState([workspace("a"), workspace("b")]);
    expect(applyOptimisticRemoveFilter(state, new Set())).toBe(state);
  });

  it("subtracts blacklisted workspace ids from `workspaces`", () => {
    const state = baseState([workspace("a"), workspace("b"), workspace("c")]);
    const filtered = applyOptimisticRemoveFilter(state, new Set(["b"]));
    expect(filtered?.workspaces.map((w) => w.id)).toEqual(["a", "c"]);
    // Original state must not be mutated — React Query consumers may
    // observe both views during a transition.
    expect(state.workspaces.map((w) => w.id)).toEqual(["a", "b", "c"]);
  });

  it("leaves non-workspace fields untouched", () => {
    const state = baseState([workspace("a")]);
    const original = state.repos;
    const filtered = applyOptimisticRemoveFilter(state, new Set(["a"]));
    expect(filtered?.workspaces).toEqual([]);
    expect(filtered?.repos).toBe(original);
  });

  it("tolerates blacklist ids that don't exist in the current state (post-rollback stale ids)", () => {
    const state = baseState([workspace("a"), workspace("b")]);
    const filtered = applyOptimisticRemoveFilter(state, new Set(["x", "y"]));
    expect(filtered?.workspaces.map((w) => w.id)).toEqual(["a", "b"]);
  });
});
