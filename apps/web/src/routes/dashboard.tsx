import type { Workspace } from "@citadel/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useMemo } from "react";
import { useEventRefresh, useStateQuery } from "../app-state.js";
import { readinessForWorkspace } from "../cockpit-readiness.js";
import { formatLabel } from "../labels.js";
import { WorkspaceCard } from "../workspace-card.js";

const COLUMNS = ["blocked", "needs-review", "working", "dirty", "idle", "done"] as const;

export function DashboardView() {
  const state = useStateQuery();
  useEventRefresh();
  const navigate = useNavigate();
  const data = state.data;
  const columns = useMemo(() => {
    const buckets: Record<string, Workspace[]> = {};
    for (const column of COLUMNS) buckets[column] = [];
    if (!data) return buckets;
    for (const workspace of data.workspaces) {
      const sessions = data.sessions.filter((session) => session.workspaceId === workspace.id);
      const operations = data.operations.filter((operation) => operation.workspaceId === workspace.id);
      const attention = readinessForWorkspace(workspace, { sessions, operations, summary: undefined });
      const key = (COLUMNS as readonly string[]).includes(attention.section) ? attention.section : "idle";
      buckets[key]?.push(workspace);
    }
    return buckets;
  }, [data]);
  return (
    <div className="page dashboard-page" style={{ padding: 0 }}>
      <header className="dashboard-header" aria-label="Dashboard navigation">
        <Link to="/" className="dashboard-back" title="Back to cockpit" aria-label="Back to cockpit">
          <ArrowLeft size={14} /> Cockpit
        </Link>
        <span className="dashboard-title">Kanban · attention</span>
      </header>
      <div className="kanban">
        {COLUMNS.map((column) => (
          <div key={column} className="kanban-column">
            <h3>
              {formatLabel(column)}
              <span className="count">{columns[column]?.length ?? 0}</span>
            </h3>
            <div className="kanban-list">
              {(columns[column] ?? []).map((workspace) => {
                const sessions = data?.sessions.filter((session) => session.workspaceId === workspace.id) ?? [];
                return (
                  <WorkspaceCard
                    key={workspace.id}
                    workspace={workspace}
                    sessions={sessions}
                    pullRequest={null}
                    active={false}
                    onSelect={() =>
                      navigate({
                        to: "/",
                        search: { workspace: workspace.id } as { workspace?: string },
                      })
                    }
                  />
                );
              })}
              {!columns[column]?.length ? <div className="nav-group-empty">No workspaces here.</div> : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
