import type { Workspace, WorkspaceRecentCommits, WorkspaceSession } from "@citadel/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "./api.js";

export function BottomBar(props: {
  activeWorkspace: Workspace | null;
  activeSession: WorkspaceSession | null;
  sessions: WorkspaceSession[];
}) {
  const [now, setNow] = useState(() => formatClock(new Date()));
  useEffect(() => {
    const id = window.setInterval(() => setNow(formatClock(new Date())), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const terminalCount = props.sessions.filter((session) => session.kind === "terminal").length;
  const autoMode = props.sessions.some(
    (s) =>
      s.kind === "agent" && (s.status === "running" || s.status === "starting" || s.status === "waiting_for_input"),
  );

  // Read the head commit of the active workspace so the status bar mirrors the
  // redesign's "* <message>" hint. Falls back silently if the workspace isn't
  // yet usable.
  const recent = useQuery<WorkspaceRecentCommits>({
    queryKey: ["recent-commits", props.activeWorkspace?.id, 1],
    queryFn: () => api<WorkspaceRecentCommits>(`/api/workspaces/${props.activeWorkspace?.id}/recent-commits?limit=1`),
    enabled: Boolean(props.activeWorkspace?.id),
    staleTime: 30_000,
  });
  const headCommitMessage = recent.data?.commits[0]?.message ?? "";
  const tmuxLabel = props.activeSession?.tmuxSessionName ?? null;

  return (
    <footer className="cit-bottombar" aria-label="Status bar">
      <div className="cit-bb-left">
        <span className="cit-bb-pill">
          <span className={`cit-pulse ${autoMode ? "cit-pulse-run" : "cit-pulse-ok"}`} aria-hidden="true" />
          auto mode {autoMode ? "running" : "on"}
        </span>
        <span className="cit-bb-divider" aria-hidden="true" />
        <span className="cit-bb-item">
          <span className="cit-bb-mono">{terminalCount}</span> {terminalCount === 1 ? "terminal" : "terminals"}
        </span>
        <span className="cit-bb-divider" aria-hidden="true" />
        <span className="cit-bb-item cit-bb-muted">
          <kbd>ctrl</kbd>+<kbd>k</kbd> palette
        </span>
        <span className="cit-bb-item cit-bb-muted">
          <kbd>c</kbd> new workspace
        </span>
      </div>
      <div className="cit-bb-right">
        {tmuxLabel ? <span className="cit-bb-tmux">[{tmuxLabel}]</span> : null}
        {headCommitMessage ? <span className="cit-bb-commit">* {headCommitMessage}</span> : null}
        <span className="cit-bb-time">{now}</span>
      </div>
    </footer>
  );
}

function formatClock(d: Date) {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}
