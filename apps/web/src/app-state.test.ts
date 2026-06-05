import type { Workspace, WorktreeCheckout } from "@citadel/contracts";
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

function checkout(id: string, workspaceId = "a"): WorktreeCheckout {
  return {
    id,
    workspaceId,
    repoId: "repo_a",
    name: id,
    path: `/tmp/${workspaceId}/${id}`,
    branch: `feat/${id}`,
    baseBranch: "main",
    issue: null,
    intendedPr: null,
    stackParentCheckoutId: null,
    inferredPurpose: null,
    gateStatus: "not_started",
    createdAt: "2026-05-25T12:00:00.000Z",
    updatedAt: "2026-05-25T12:00:00.000Z",
    archivedAt: null,
  };
}

function baseState(workspaces: Workspace[], checkouts: WorktreeCheckout[] = []): StateResponse {
  return {
    repos: [],
    workspaces,
    checkouts,
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
    const state = baseState(
      [workspace("a"), workspace("b"), workspace("c")],
      [checkout("co_a", "a"), checkout("co_b", "b")],
    );
    const filtered = applyOptimisticRemoveFilter(state, new Set(["b"]));
    expect(filtered?.workspaces.map((w) => w.id)).toEqual(["a", "c"]);
    expect(filtered?.checkouts.map((checkout) => checkout.id)).toEqual(["co_a"]);
    // Original state must not be mutated — React Query consumers may
    // observe both views during a transition.
    expect(state.workspaces.map((w) => w.id)).toEqual(["a", "b", "c"]);
    expect(state.checkouts.map((checkout) => checkout.id)).toEqual(["co_a", "co_b"]);
  });

  it("subtracts blacklisted checkout ids from `checkouts` without removing the workspace", () => {
    const state = baseState([workspace("a")], [checkout("co_a", "a"), checkout("co_b", "a")]);
    const filtered = applyOptimisticRemoveFilter(state, new Set(), new Set(["co_b"]));
    expect(filtered?.workspaces.map((w) => w.id)).toEqual(["a"]);
    expect(filtered?.checkouts.map((entry) => entry.id)).toEqual(["co_a"]);
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
