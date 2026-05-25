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
import { useEffect } from "react";
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
