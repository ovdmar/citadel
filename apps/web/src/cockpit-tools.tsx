import type { PullRequestSummary, Workspace, WorkspaceCockpitSummary } from "@citadel/contracts";
import type { WorkspaceCockpitSummaryBatchResponse } from "@citadel/contracts/pr-routes";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
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

// Client-side filtering: only root workspaces are dropped here. The daemon
// decides remote-less and returns a {ok:false, reason:"no-remote"} envelope
// without spawning gh — the client just consumes it.
export function filterPollableWorkspaceIds(workspaces: Workspace[]) {
  return workspaces.filter((workspace) => workspace.kind !== "root").map((workspace) => workspace.id);
}

// Decide the batch poll's refetch interval. Pauses when the cockpit tab is
// hidden so the daemon doesn't burn gh subprocesses while the user is away.
// Returning `false` from refetchInterval (react-query v5) pauses polling.
export function nextPollInterval(visibilityState: "visible" | "hidden" | undefined): 30_000 | false {
  if (visibilityState === "hidden") return false;
  return 30_000;
}

// Always-on cross-workspace PR poll. Stable queryKey so workspace adds/removes
// don't flash placeholders; placeholderData: keepPreviousData (v5 syntax —
// `keepPreviousData: true` is v4 and silently no-ops here) holds the previous
// map until the new fetch resolves. refetchOnWindowFocus resumes immediately
// on tab focus.
export function useAllWorkspacesPrSummary(workspaces: Workspace[]) {
  const filteredIds = filterPollableWorkspaceIds(workspaces);
  return useQuery({
    queryKey: ["workspaces-pr-batch"],
    enabled: filteredIds.length > 0,
    refetchInterval: () => nextPollInterval(typeof document === "undefined" ? "visible" : document.visibilityState),
    refetchOnWindowFocus: true,
    placeholderData: keepPreviousData,
    queryFn: () =>
      api<WorkspaceCockpitSummaryBatchResponse>("/api/workspaces/cockpit-summary/batch", {
        method: "POST",
        body: JSON.stringify({ ids: filteredIds }),
      }),
  });
}

// Build a Map<workspaceId, PullRequestSummary | null> from the batch response.
// Per-workspace failures (no-remote, root-workspace) collapse to `null` so
// the workspace card can render its placeholder slot without further work.
export function prMapFromBatch(batch: WorkspaceCockpitSummaryBatchResponse | undefined) {
  const map = new Map<string, PullRequestSummary | null>();
  if (!batch) return map;
  for (const entry of batch.summaries) {
    if (entry.ok) {
      const summary = entry.summary as WorkspaceCockpitSummary;
      map.set(entry.workspaceId, summary.versionControl.pullRequest ?? null);
    } else {
      map.set(entry.workspaceId, null);
    }
  }
  return map;
}
