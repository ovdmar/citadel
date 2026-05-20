import type { Workspace, WorkspaceCockpitSummary } from "@citadel/contracts";
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
