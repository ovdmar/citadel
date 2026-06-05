import type { SystemHealthSnapshot, Workspace } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { type StateResponse, applyOptimisticRemoveFilter, parseSseSystemHealth } from "./app-state.js";

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

describe("parseSseSystemHealth", () => {
  it("extracts and validates the system-health.updated payload", () => {
    expect(parseSseSystemHealth(message({ payload: systemHealthSnapshot }))).toEqual(systemHealthSnapshot);
  });

  it("returns null for malformed or invalid SSE payloads", () => {
    expect(parseSseSystemHealth(message({ payload: { tone: "healthy" } }))).toBeNull();
    expect(parseSseSystemHealth({ data: "not-json" } as MessageEvent)).toBeNull();
  });
});

function message(data: unknown): MessageEvent {
  return { data: JSON.stringify(data) } as MessageEvent;
}

const systemHealthSnapshot: SystemHealthSnapshot = {
  tone: "healthy",
  reason: null,
  checkedAt: "2026-06-05T00:00:00.000Z",
  machine: {
    cpu: { percentUsed: 12, loadAverage1m: 0.5, cores: 8 },
    memory: { totalBytes: 100, usedBytes: 50, freeBytes: 50, percentUsed: 50 },
    disk: {
      path: "/tmp/citadel",
      device: "sda1",
      totalBytes: 100,
      usedBytes: 35,
      freeBytes: 65,
      percentUsed: 35,
      ioUtilizationPercent: 10,
      error: null,
    },
  },
  process: { pid: 123, rssBytes: 40, heapUsedBytes: 20, heapTotalBytes: 30, percentOfMachineMemory: 1 },
};
