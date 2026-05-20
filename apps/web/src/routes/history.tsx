import type { Workspace } from "@citadel/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api, queryClient } from "../api.js";
import { useEventRefresh, useStateQuery } from "../app-state.js";
import { Button } from "../components/ui/button.js";
import { formatLabel } from "../labels.js";

export function HistoryView() {
  const state = useStateQuery();
  useEventRefresh();
  const archived = useQuery<{ workspaces: Workspace[] }>({
    queryKey: ["archived-workspaces"],
    queryFn: () => api<{ workspaces: Workspace[] }>("/api/workspaces/archived"),
    refetchInterval: 15_000,
  });
  const repos = state.data?.repos ?? [];
  const unarchive = useMutation({
    mutationFn: (workspaceId: string) => api(`/api/workspaces/${workspaceId}/unarchive`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      queryClient.invalidateQueries({ queryKey: ["archived-workspaces"] });
    },
  });
  const rows = archived.data?.workspaces ?? [];
  return (
    <div className="page" style={{ padding: 0 }}>
      <header className="header" style={{ padding: "12px 16px" }}>
        <div>
          <h1>History</h1>
          <p className="command-result-meta">
            Archived workspaces with PR snapshot, lifecycle outcome, and unarchive when the worktree is still on disk.
          </p>
        </div>
      </header>
      <div style={{ overflow: "auto" }}>
        {rows.length ? (
          <table className="history-table">
            <thead>
              <tr>
                <th>Workspace</th>
                <th>Repo</th>
                <th>Branch</th>
                <th>Archived</th>
                <th>Lifecycle</th>
                <th>PR</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((workspace) => {
                const repo = repos.find((entry) => entry.id === workspace.repoId);
                const canUnarchive = workspace.lifecycle !== "removed";
                return (
                  <tr key={workspace.id}>
                    <td>
                      <strong>{workspace.name}</strong>
                      <div className="command-result-meta">
                        {workspace.issueKey ? `${workspace.issueKey} · ` : ""}
                        {workspace.issueTitle ?? ""}
                      </div>
                    </td>
                    <td>{repo?.name ?? workspace.repoId}</td>
                    <td>
                      <code style={{ fontSize: 11 }}>{workspace.branch}</code>
                    </td>
                    <td>{workspace.archivedAt?.slice(0, 16).replace("T", " ") ?? "—"}</td>
                    <td>{formatLabel(workspace.lifecycle)}</td>
                    <td>
                      {workspace.prUrl ? (
                        <a href={workspace.prUrl} target="_blank" rel="noreferrer">
                          PR link
                        </a>
                      ) : (
                        <span className="command-result-meta">No PR recorded</span>
                      )}
                    </td>
                    <td>
                      <Button
                        type="button"
                        variant="secondary"
                        disabled={!canUnarchive || unarchive.isPending}
                        onClick={() => unarchive.mutate(workspace.id)}
                      >
                        {canUnarchive ? "Unarchive" : "Removed"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="history-empty">No archived workspaces yet.</div>
        )}
      </div>
    </div>
  );
}
