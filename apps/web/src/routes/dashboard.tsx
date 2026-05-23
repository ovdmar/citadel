import type { Workspace } from "@citadel/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useEventRefresh, useStateQuery } from "../app-state.js";
import { formatLabel } from "../labels.js";
import { NamespacesView } from "../namespaces-view.js";
import { WorkspaceCard } from "../workspace-card.js";

const COLUMNS = ["backlog", "working", "needs-review", "blocked", "done"] as const;
const TAB_STORAGE = "citadel.dashboard-tab";
type Tab = "kanban" | "namespaces";

export function DashboardView() {
  const state = useStateQuery();
  useEventRefresh();
  const navigate = useNavigate();
  const data = state.data;
  const [tab, setTab] = useState<Tab>(() => {
    if (typeof window === "undefined") return "kanban";
    return (window.localStorage.getItem(TAB_STORAGE) as Tab | null) ?? "kanban";
  });
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(TAB_STORAGE, tab);
  }, [tab]);
  const columns = useMemo(() => {
    const buckets: Record<string, Workspace[]> = {};
    for (const column of COLUMNS) buckets[column] = [];
    if (!data) return buckets;
    for (const workspace of data.workspaces) {
      const key = (COLUMNS as readonly string[]).includes(workspace.section) ? workspace.section : "backlog";
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
        <div className="dashboard-tabs" role="tablist" aria-label="Dashboard view">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "kanban"}
            className={tab === "kanban" ? "active" : ""}
            onClick={() => setTab("kanban")}
          >
            Kanban
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "namespaces"}
            className={tab === "namespaces" ? "active" : ""}
            onClick={() => setTab("namespaces")}
          >
            Namespaces
          </button>
        </div>
      </header>
      {tab === "kanban" ? (
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
      ) : (
        <NamespacesView data={data} />
      )}
    </div>
  );
}
