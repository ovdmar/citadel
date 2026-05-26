import type {
  ActivityEvent,
  AgentRuntime,
  AgentSession,
  Namespace,
  Operation,
  ProviderHealth,
  Repo,
  ScheduledAgent,
  Workspace,
} from "@citadel/contracts";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, createContext, createElement, useContext, useEffect, useMemo, useState } from "react";
import { api, queryClient } from "./api.js";

export type StateResponse = {
  repos: Repo[];
  workspaces: Workspace[];
  sessions: AgentSession[];
  operations: Operation[];
  activity: ActivityEvent[];
  providerHealth: ProviderHealth[];
  runtimes: AgentRuntime[];
  mcp: { enabled: boolean; resources: string[]; tools: string[] };
  scheduledAgents: ScheduledAgent[];
  namespaces: Namespace[];
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

// Wrapper hook for consumers that render the workspace list: subtracts
// optimistically-removed ids from `workspaces[]` at READ time. The
// underlying `["state"]` query is the same one `useStateQuery` returns —
// React Query dedupes, so we don't pay an extra fetch.
export function useFilteredStateQuery(options?: { enabled?: boolean }) {
  const result = useStateQuery(options);
  const { ids } = useOptimisticRemove();
  const filtered = useMemo(() => {
    if (!result.data || ids.size === 0) return result.data;
    return { ...result.data, workspaces: result.data.workspaces.filter((w) => !ids.has(w.id)) };
  }, [result.data, ids]);
  return { ...result, data: filtered };
}

export function useEventRefresh() {
  useEffect(() => {
    const events = new EventSource("/events");
    events.onmessage = () => queryClient.invalidateQueries({ queryKey: ["state"] });
    events.addEventListener("repo.updated", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
    events.addEventListener("workspace.updated", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
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
