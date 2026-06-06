import type { Repo, SystemHealthSnapshot, Workspace, WorktreeCheckout } from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import {
  type StateResponse,
  addOptimisticCheckout,
  applyOptimisticRemoveFilter,
  createOptimisticCheckout,
  invalidatePrQueriesFromSse,
  parseSseSystemHealth,
  reconcileOptimisticCheckout,
  removeOptimisticCheckout,
} from "./app-state.js";

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

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: "repo_a",
    name: "citadel",
    rootPath: "/repo/citadel",
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: "/worktrees",
    providerRepositoryKey: "ovdmar/citadel",
    showMainWorkspace: false,
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: [],
    deployHookCommand: null,
    createdAt: "2026-05-25T12:00:00.000Z",
    updatedAt: "2026-05-25T12:00:00.000Z",
    archivedAt: null,
    ...overrides,
  };
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

describe("parseSseSystemHealth", () => {
  it("extracts and validates the system-health.updated payload", () => {
    expect(parseSseSystemHealth(message({ payload: systemHealthSnapshot }))).toEqual(systemHealthSnapshot);
  });

  it("returns null for malformed or invalid SSE payloads", () => {
    expect(parseSseSystemHealth(message({ payload: { tone: "healthy" } }))).toBeNull();
    expect(parseSseSystemHealth({ data: "not-json" } as MessageEvent)).toBeNull();
  });
});

describe("invalidatePrQueriesFromSse", () => {
  it("invalidates state and PR queries for a workspace PR event", () => {
    const calls: Array<{ queryKey: readonly unknown[] }> = [];
    invalidatePrQueriesFromSse(
      { invalidateQueries: (input) => calls.push(input) },
      message({ payload: { workspaceId: "ws_pr" } }),
    );

    expect(calls).toEqual([
      { queryKey: ["state"] },
      { queryKey: ["workspaces-pr-state"] },
      { queryKey: ["workspaces-pr-batch"] },
      { queryKey: ["workspace-cockpit", "ws_pr"] },
    ]);
  });

  it("still invalidates global PR queries when the event payload is malformed", () => {
    const calls: Array<{ queryKey: readonly unknown[] }> = [];
    invalidatePrQueriesFromSse({ invalidateQueries: (input) => calls.push(input) }, {
      data: "not-json",
    } as MessageEvent);

    expect(calls).toEqual([
      { queryKey: ["state"] },
      { queryKey: ["workspaces-pr-state"] },
      { queryKey: ["workspaces-pr-batch"] },
    ]);
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

describe("optimistic checkout state helpers", () => {
  it("builds and inserts a pending checkout under the workspace root", () => {
    const ws = workspace("ws_home");
    const pending = createOptimisticCheckout({
      id: "co_pending",
      workspace: { ...ws, rootPath: "/tmp/ws_home" },
      repo: repo(),
      name: "payments-ui",
      displayName: "Payments UI",
      branch: "payments-ui",
      now: "2026-06-05T12:00:00.000Z",
    });
    const state = baseState([{ ...ws, rootPath: "/tmp/ws_home" }]);
    const next = addOptimisticCheckout(state, pending);

    expect(next?.checkouts).toHaveLength(1);
    expect(next?.checkouts[0]).toMatchObject({
      id: "co_pending",
      workspaceId: "ws_home",
      repoId: "repo_a",
      name: "payments-ui",
      displayName: "Payments UI",
      path: "/tmp/ws_home/payments-ui",
      branch: "payments-ui",
      baseBranch: "main",
      gateStatus: "not_started",
    });
    expect(state.checkouts).toEqual([]);
  });

  it("reconciles a pending checkout id to the daemon id without waiting for a refetch", () => {
    const pending = checkout("co_pending", "ws_home");
    const state = baseState([workspace("ws_home")], [pending]);
    const next = reconcileOptimisticCheckout(state, "co_pending", "co_real");

    expect(next?.checkouts.map((entry) => entry.id)).toEqual(["co_real"]);
    expect(next?.checkouts[0]).toMatchObject({ name: pending.name, path: pending.path });
  });

  it("drops the pending row when the daemon already returned the real checkout", () => {
    const state = baseState(
      [workspace("ws_home")],
      [checkout("co_pending", "ws_home"), checkout("co_real", "ws_home")],
    );
    const next = reconcileOptimisticCheckout(state, "co_pending", "co_real");

    expect(next?.checkouts.map((entry) => entry.id)).toEqual(["co_real"]);
  });

  it("removes a pending checkout after create failure", () => {
    const state = baseState(
      [workspace("ws_home")],
      [checkout("co_pending", "ws_home"), checkout("co_other", "ws_home")],
    );
    const next = removeOptimisticCheckout(state, "co_pending");

    expect(next?.checkouts.map((entry) => entry.id)).toEqual(["co_other"]);
  });
});
