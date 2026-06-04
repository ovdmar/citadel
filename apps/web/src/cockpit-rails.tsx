import type { Workspace, WorkspaceSession } from "@citadel/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ChevronsRight, Search as SearchIcon, Settings as SettingsIcon } from "lucide-react";

export function CollapsedLeftRail(props: {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  sessions: WorkspaceSession[];
  onExpand: () => void;
  onPickWorkspace: (workspace: Workspace) => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const recent = [...props.workspaces].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
  return (
    <aside className="collapsed-rail col-left">
      <button
        type="button"
        className="collapsed-mini-btn"
        onClick={props.onExpand}
        aria-label="Expand navigator"
        title="Expand"
      >
        <ChevronsRight size={15} />
      </button>
      <div className="collapsed-mini-divider" aria-hidden />
      <button
        type="button"
        className={`collapsed-mini-btn ${location.pathname === "/dashboard" ? "is-active" : ""}`}
        title="Dashboard"
        onClick={() => navigate({ to: "/dashboard" })}
      >
        <SearchIcon size={15} />
      </button>
      <button
        type="button"
        className={`collapsed-mini-btn ${location.pathname === "/history" ? "is-active" : ""}`}
        title="History"
        onClick={() => navigate({ to: "/history" })}
      >
        <SettingsIcon size={15} />
      </button>
      <div className="collapsed-mini-divider" aria-hidden />
      <div className="collapsed-mini-stack">
        {recent.map((workspace) => {
          const isActive = workspace.id === props.activeWorkspaceId;
          const running = props.sessions.some(
            (session) => session.workspaceId === workspace.id && session.status === "running",
          );
          const letter = (workspace.name.match(/[A-Za-z0-9]/)?.[0] ?? workspace.name[0] ?? "?").toUpperCase();
          return (
            <button
              key={workspace.id}
              type="button"
              className={`collapsed-mini-ws ${isActive ? "is-selected" : ""}`}
              title={`${workspace.name} · ${workspace.branch}`}
              onClick={() => props.onPickWorkspace(workspace)}
            >
              <span className="collapsed-mini-letter">{letter}</span>
              {running ? <span className="collapsed-mini-dot" aria-hidden /> : null}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
