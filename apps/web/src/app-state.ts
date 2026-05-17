import type { ActivityEvent, AgentRuntime, AgentSession, ProviderHealth, Repo, Workspace } from "@citadel/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { api, queryClient } from "./api.js";

export type StateResponse = {
  repos: Repo[];
  workspaces: Workspace[];
  sessions: AgentSession[];
  operations: unknown[];
  activity: ActivityEvent[];
  providerHealth: ProviderHealth[];
  runtimes: AgentRuntime[];
  mcp: { enabled: boolean; resources: string[]; tools: string[] };
};

export function useStateQuery() {
  return useQuery({
    queryKey: ["state"],
    queryFn: () => api<StateResponse>("/api/state"),
    refetchInterval: 5000,
  });
}

export function useEventRefresh() {
  useEffect(() => {
    const events = new EventSource("/events");
    events.onmessage = () => queryClient.invalidateQueries({ queryKey: ["state"] });
    events.addEventListener("workspace.updated", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
    events.addEventListener("agent.updated", () => queryClient.invalidateQueries({ queryKey: ["state"] }));
    return () => events.close();
  }, []);
}
