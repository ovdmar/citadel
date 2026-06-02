import type {
  ActivityEvent,
  AgentRuntime,
  Namespace,
  Operation,
  PlanDeviationReport,
  ProviderHealth,
  Repo,
  ScheduledAgent,
  TerminalProfile,
  Workspace,
  WorkspaceManager,
  WorkspacePlanDeliveryUnit,
  WorkspacePlanDependencyEdge,
  WorkspacePlanVersion,
  WorkspaceSession,
  WorktreeCheckout,
} from "@citadel/contracts";
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

export function useStateQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["state"],
    queryFn: () => api<StateResponse>("/api/state"),
    refetchInterval: 5000,
    enabled: options?.enabled ?? true,
  });
}

// AC4 — optimistic-remove blacklist. While a workspace id is in this set,
// `useFilteredStateQuery` subtracts it from `workspaces[]` so the 5s
// refetch (or any post-invalidate refetch) can't resurrect the row mid
// teardown. Lifecycle is mutation-bound: `onMutate` adds the id;
// `onSettled` removes it. No timer — survives slow teardowns (hook
// scripts can take minutes).
type OptimisticRemoveContextValue = {
  ids: ReadonlySet<string>;
  add: (id: string) => void;
  remove: (id: string) => void;
};

const OptimisticRemoveContext = createContext<OptimisticRemoveContextValue>({
  ids: new Set<string>(),
  add: () => undefined,
  remove: () => undefined,
});

export function OptimisticRemoveProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const value = useMemo<OptimisticRemoveContextValue>(
    () => ({
      ids,
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
    }),
    [ids],
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
): StateResponse | undefined {
  if (!state || ids.size === 0) return state;
  return {
    ...state,
    workspaces: state.workspaces.filter((w) => !ids.has(w.id)),
    checkouts: state.checkouts.filter((checkout) => !ids.has(checkout.workspaceId)),
    workspacePlans: state.workspacePlans.filter((plan) => !ids.has(plan.workspaceId)),
    workspacePlanDeliveryUnits: state.workspacePlanDeliveryUnits.filter(
      (unit) => !unit.workspaceId || !ids.has(unit.workspaceId),
    ),
    workspacePlanDependencyEdges: state.workspacePlanDependencyEdges.filter(
      (edge) => !edge.workspaceId || !ids.has(edge.workspaceId),
    ),
    workspaceManagers: state.workspaceManagers.filter((manager) => !ids.has(manager.workspaceId)),
    planDeviations: state.planDeviations.filter((report) => !ids.has(report.workspaceId)),
  };
}

// Wrapper hook for consumers that render the workspace list: subtracts
// optimistically-removed ids from `workspaces[]` at READ time. The
// underlying `["state"]` query is the same one `useStateQuery` returns —
// React Query dedupes, so we don't pay an extra fetch.
export function useFilteredStateQuery(options?: { enabled?: boolean }) {
  const result = useStateQuery(options);
  const { ids } = useOptimisticRemove();
  const filtered = useMemo(() => applyOptimisticRemoveFilter(result.data, ids), [result.data, ids]);
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
    events.addEventListener("scheduled-agent.updated", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
    events.addEventListener("scheduled-agent.run", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
    events.addEventListener("namespace.updated", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
    events.addEventListener("workspace.fsChanged", (ev) => {
      const workspaceId = parseSseWorkspaceId(ev as MessageEvent);
      if (workspaceId) {
        queryClient.invalidateQueries({ queryKey: ["workspace-cockpit", workspaceId] });
      } else {
        queryClient.invalidateQueries({ queryKey: ["workspace-cockpit"] });
      }
    });
    return () => events.close();
  }, []);
}

function parseSseWorkspaceId(event: MessageEvent): string | null {
  try {
    const data = JSON.parse(event.data) as { payload?: { workspaceId?: unknown } };
    const id = data?.payload?.workspaceId;
    return typeof id === "string" && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}
