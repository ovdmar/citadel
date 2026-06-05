import type {
  ActivityEvent,
  AgentRuntime,
  LocalNotificationEvent,
  ManagerActionLedgerEntry,
  Namespace,
  Operation,
  PlanDeviationReport,
  ProviderHealth,
  Repo,
  ScheduledAgent,
  SystemHealthSnapshot,
  TerminalProfile,
  Workspace,
  WorkspaceManager,
  WorkspacePlanDeliveryUnit,
  WorkspacePlanDependencyEdge,
  WorkspacePlanVersion,
  WorkspaceSession,
  WorktreeCheckout,
} from "@citadel/contracts";
import { SystemHealthSnapshotSchema } from "@citadel/contracts";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, createContext, createElement, useContext, useEffect, useMemo, useState } from "react";
import { api, queryClient } from "./api.js";

// Boot-time auto-restore summary. Surfaced in /api/state so the cockpit
// banner can show "Restored N sessions from previous run" the first time the
// user loads the cockpit after a daemon restart.
export type BootRestoreSummary = {
  bootedAt: string;
  finishedAt: string | null;
  entries: Array<{
    workspaceId: string;
    workspaceName: string;
    runtimeId: string;
    runtimeSessionId: string;
    sessionId: string | null;
    error: string | null;
  }>;
  skippedOlder: number;
};

export type StateResponse = {
  repos: Repo[];
  workspaces: Workspace[];
  checkouts: WorktreeCheckout[];
  workspacePlans: WorkspacePlanVersion[];
  workspacePlanDeliveryUnits: WorkspacePlanDeliveryUnit[];
  workspacePlanDependencyEdges: WorkspacePlanDependencyEdge[];
  workspaceManagers: WorkspaceManager[];
  managerActions: ManagerActionLedgerEntry[];
  localNotifications: LocalNotificationEvent[];
  planDeviations: PlanDeviationReport[];
  sessions: WorkspaceSession[];
  operations: Operation[];
  activity: ActivityEvent[];
  providerHealth: ProviderHealth[];
  agentRuntimes: AgentRuntime[];
  terminal: TerminalProfile;
  mcp: { enabled: boolean; resources: string[]; tools: string[] };
  scheduledAgents: ScheduledAgent[];
  namespaces: Namespace[];
  bootRestore: BootRestoreSummary | null;
};

export type OptimisticCheckoutInput = {
  id: string;
  workspace: Workspace;
  repo: Repo;
  name: string;
  displayName?: string | null;
  branch: string;
  now: string;
};

export function createOptimisticCheckout(input: OptimisticCheckoutInput): WorktreeCheckout {
  const root = input.workspace.rootPath ?? input.workspace.path;
  return {
    id: input.id,
    workspaceId: input.workspace.id,
    repoId: input.repo.id,
    name: input.name,
    displayName: input.displayName ?? null,
    path: `${root.replace(/\/+$/, "")}/${input.name}`,
    branch: input.branch,
    baseBranch: input.repo.defaultBranch,
    issue: null,
    intendedPr: null,
    stackParentCheckoutId: null,
    inferredPurpose: null,
    gateStatus: "not_started",
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
  };
}

export function addOptimisticCheckout(
  state: StateResponse | undefined,
  checkout: WorktreeCheckout,
): StateResponse | undefined {
  if (!state) return state;
  if (state.checkouts.some((entry) => entry.id === checkout.id)) return state;
  return { ...state, checkouts: [...state.checkouts, checkout] };
}

export function reconcileOptimisticCheckout(
  state: StateResponse | undefined,
  optimisticId: string,
  checkoutId: string,
): StateResponse | undefined {
  if (!state) return state;
  const serverCheckoutExists = state.checkouts.some((entry) => entry.id === checkoutId);
  let changed = false;
  const checkouts = state.checkouts.flatMap((checkout) => {
    if (checkout.id !== optimisticId) return [checkout];
    changed = true;
    return serverCheckoutExists ? [] : [{ ...checkout, id: checkoutId }];
  });
  return changed ? { ...state, checkouts } : state;
}

export function removeOptimisticCheckout(
  state: StateResponse | undefined,
  optimisticId: string,
): StateResponse | undefined {
  if (!state) return state;
  const checkouts = state.checkouts.filter((checkout) => checkout.id !== optimisticId);
  return checkouts.length === state.checkouts.length ? state : { ...state, checkouts };
}

export function useStateQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["state"],
    queryFn: () => api<StateResponse>("/api/state"),
    refetchInterval: 5000,
    enabled: options?.enabled ?? true,
  });
}

// Optimistic-remove blacklist. While a workspace or checkout id is in
// this set, `useFilteredStateQuery` subtracts it from the relevant state
// slices so the 5s refetch (or any post-invalidate refetch) can't
// resurrect the row mid teardown. Lifecycle is mutation-bound: `onMutate`
// adds the id; `onSettled` removes it. No timer — survives slow teardowns
// (hook scripts can take minutes).
type OptimisticRemoveContextValue = {
  ids: ReadonlySet<string>;
  checkoutIds: ReadonlySet<string>;
  add: (id: string) => void;
  remove: (id: string) => void;
  addCheckout: (id: string) => void;
  removeCheckout: (id: string) => void;
};

const OptimisticRemoveContext = createContext<OptimisticRemoveContextValue>({
  ids: new Set<string>(),
  checkoutIds: new Set<string>(),
  add: () => undefined,
  remove: () => undefined,
  addCheckout: () => undefined,
  removeCheckout: () => undefined,
});

export function OptimisticRemoveProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [checkoutIds, setCheckoutIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const value = useMemo<OptimisticRemoveContextValue>(
    () => ({
      ids,
      checkoutIds,
      add: (id: string) =>
        setIds((prev) => {
          if (prev.has(id)) return prev;
          const next = new Set(prev);
          next.add(id);
          return next;
        }),
      remove: (id: string) =>
        setIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        }),
      addCheckout: (id: string) =>
        setCheckoutIds((prev) => {
          if (prev.has(id)) return prev;
          const next = new Set(prev);
          next.add(id);
          return next;
        }),
      removeCheckout: (id: string) =>
        setCheckoutIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        }),
    }),
    [ids, checkoutIds],
  );
  return createElement(OptimisticRemoveContext.Provider, { value }, children);
}

export function useOptimisticRemove(): OptimisticRemoveContextValue {
  return useContext(OptimisticRemoveContext);
}

// Pure subtraction: returns a copy of `state` with `workspaces` filtered
// to exclude any id in `ids`. Identity-stable when `ids` is empty or
// state is undefined so React doesn't churn references unnecessarily.
// Exported separately so it can be unit-tested without React's hook
// machinery.
export function applyOptimisticRemoveFilter(
  state: StateResponse | undefined,
  ids: ReadonlySet<string>,
  checkoutIds: ReadonlySet<string> = new Set<string>(),
): StateResponse | undefined {
  if (!state || (ids.size === 0 && checkoutIds.size === 0)) return state;
  return {
    ...state,
    workspaces: state.workspaces.filter((w) => !ids.has(w.id)),
    checkouts: state.checkouts.filter((checkout) => !ids.has(checkout.workspaceId) && !checkoutIds.has(checkout.id)),
    workspacePlans: state.workspacePlans.filter((plan) => !ids.has(plan.workspaceId)),
    workspacePlanDeliveryUnits: state.workspacePlanDeliveryUnits.filter(
      (unit) => !unit.workspaceId || !ids.has(unit.workspaceId),
    ),
    workspacePlanDependencyEdges: state.workspacePlanDependencyEdges.filter(
      (edge) => !edge.workspaceId || !ids.has(edge.workspaceId),
    ),
    workspaceManagers: state.workspaceManagers.filter((manager) => !ids.has(manager.workspaceId)),
    managerActions: state.managerActions.filter(
      (action) => !ids.has(action.workspaceId) && (!action.checkoutId || !checkoutIds.has(action.checkoutId)),
    ),
    localNotifications: state.localNotifications.filter(
      (event) => !ids.has(event.workspaceId) && (!event.checkoutId || !checkoutIds.has(event.checkoutId)),
    ),
    planDeviations: state.planDeviations.filter(
      (report) => !ids.has(report.workspaceId) && (!report.checkoutId || !checkoutIds.has(report.checkoutId)),
    ),
  };
}

// Wrapper hook for consumers that render the workspace list: subtracts
// optimistically-removed ids from `workspaces[]` at READ time. The
// underlying `["state"]` query is the same one `useStateQuery` returns —
// React Query dedupes, so we don't pay an extra fetch.
export function useFilteredStateQuery(options?: { enabled?: boolean }) {
  const result = useStateQuery(options);
  const { ids, checkoutIds } = useOptimisticRemove();
  const filtered = useMemo(
    () => applyOptimisticRemoveFilter(result.data, ids, checkoutIds),
    [result.data, ids, checkoutIds],
  );
  return { ...result, data: filtered };
}

export function useEventRefresh() {
  useEffect(() => {
    const events = new EventSource("/events");
    events.onmessage = () => queryClient.invalidateQueries({ queryKey: ["state"] });
    events.addEventListener("repo.updated", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
    events.addEventListener("workspace.updated", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
    events.addEventListener("workspace.manager.updated", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
    events.addEventListener("workspace.plan.updated", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
    events.addEventListener("workspace.plan.deviation", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
    events.addEventListener("checkout.gate.updated", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
    events.addEventListener("ticket.updated", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
    events.addEventListener("agent.updated", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
    events.addEventListener("terminal.updated", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
    events.addEventListener("workspace-session.updated", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
    events.addEventListener("scheduled-agent.updated", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
    events.addEventListener("scheduled-agent.run", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
    events.addEventListener("namespace.updated", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
    events.addEventListener("system-health.updated", (ev) => {
      const systemHealth = parseSseSystemHealth(ev as MessageEvent);
      if (systemHealth) queryClient.setQueryData(["system-health"], { systemHealth });
    });
    return () => events.close();
  }, []);
}

export function parseSseSystemHealth(event: MessageEvent): SystemHealthSnapshot | null {
  try {
    const data = JSON.parse(event.data) as { payload?: unknown };
    const parsed = SystemHealthSnapshotSchema.safeParse(data.payload);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
