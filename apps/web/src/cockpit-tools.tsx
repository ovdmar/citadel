import type { Workspace, WorkspaceCockpitSummary, WorkspacesPrStateResponse } from "@citadel/contracts";
import { useQuery } from "@tanstack/react-query";
import { api } from "./api.js";

export { RuntimeLauncher, WorkspaceForm } from "./workspace-forms.js";
export { TerminalPane } from "./terminal-pane.js";

export function useWorkspaceCockpitSummary(workspace: Workspace | null) {
  return useQuery({
    queryKey: ["workspace-cockpit", workspace?.id],
    enabled: Boolean(workspace),
    refetchInterval: 10_000,
    queryFn: () => api<WorkspaceCockpitSummary>(`/api/workspaces/${workspace?.id}/cockpit-summary`),
  });
}

// Navigator-wide PR/CI snapshot. Polled every 30s (lighter than the per-
// workspace cockpit-summary cadence) — the background refresh job is the
// freshness driver. Focus invalidation in useFocusRefresh also busts this
// query so newly-focused windows see fresh data immediately.
export function useWorkspacesPrState() {
  return useQuery({
    queryKey: ["workspaces-pr-state"],
    refetchInterval: 30_000,
    staleTime: 25_000,
    queryFn: () => api<WorkspacesPrStateResponse>("/api/workspaces/pr-state"),
  });
}
