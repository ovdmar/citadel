import type { AgentRuntime, AgentSession, Workspace } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import { Plus, TerminalSquare, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, queryClient } from "./api.js";
import { TerminalPane } from "./terminal-pane.js";

type StageTab = {
  session: AgentSession;
  label: string;
};

export function Stage(props: {
  workspace: Workspace;
  sessions: AgentSession[];
  allSessions?: AgentSession[];
  runtimes: AgentRuntime[];
  activeSessionId: string | undefined;
  onActiveSession: (id: string) => void;
}) {
  const sortedSessions = [...props.sessions].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const tabs: StageTab[] = sortedSessions.map((session) => ({ session, label: session.displayName }));
  const allSessions = props.allSessions ?? props.sessions;

  // If the caller just selected a session that hasn't shown up in props.sessions
  // yet (mutation responded, query refetch in flight), keep that ID even though
  // it's not in `tabs` — otherwise we'd snap focus back to tabs[0] and clobber
  // the user's selection (e.g. right after starting a new agent). After a short
  // grace period (e.g. persisted ID from localStorage that no longer exists),
  // fall back to the first tab.
  const pendingActive = Boolean(props.activeSessionId && !tabs.some((tab) => tab.session.id === props.activeSessionId));
  const [graceExpired, setGraceExpired] = useState(false);
  useEffect(() => {
    if (!pendingActive) {
      if (graceExpired) setGraceExpired(false);
      return;
    }
    setGraceExpired(false);
    const timeout = window.setTimeout(() => setGraceExpired(true), 4000);
    return () => window.clearTimeout(timeout);
  }, [pendingActive, graceExpired]);
  const keepPending = pendingActive && !graceExpired;
  const activeSession = keepPending
    ? null
    : (tabs.find((tab) => tab.session.id === props.activeSessionId) ?? tabs[0] ?? null);
  useEffect(() => {
    if (keepPending) return;
    if (activeSession && activeSession.session.id !== props.activeSessionId) {
      props.onActiveSession(activeSession.session.id);
    }
  }, [activeSession, keepPending, props]);

  // Keep TerminalPane instances alive across workspace/session switches once
  // the user has actually opened them. The set grows when a session becomes
  // active and shrinks when the underlying session goes away. Without this,
  // every workspace switch unmounts the previously-visible iframe — ttyd
  // tears down the WebSocket and re-handshakes on remount, which the user
  // perceives as a grey flash on the main stage.
  const [visitedIds, setVisitedIds] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (props.activeSessionId) initial.add(props.activeSessionId);
    return initial;
  });
  useEffect(() => {
    if (!activeSession) return;
    const id = activeSession.session.id;
    setVisitedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, [activeSession]);
  useEffect(() => {
    setVisitedIds((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(allSessions.map((session) => session.id));
      const next = new Set<string>();
      for (const id of prev) if (live.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [allSessions]);
  const visitedPanes = allSessions.filter((session) => visitedIds.has(session.id));

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const addMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!addMenuOpen) return;
    const onClick = (event: MouseEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node)) setAddMenuOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [addMenuOpen]);

  const startSession = useMutation({
    mutationFn: (input: { runtimeId: string; displayName: string }) =>
      api<{ session: AgentSession }>("/api/agent-sessions", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: props.workspace.id,
          runtimeId: input.runtimeId,
          displayName: input.displayName,
        }),
      }),
    onSuccess: ({ session }) => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      props.onActiveSession(session.id);
      setAddMenuOpen(false);
    },
  });

  const stopSession = useMutation({
    mutationFn: (sessionId: string) => api(`/api/agent-sessions/${sessionId}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const renameSession = useMutation({
    mutationFn: (input: { sessionId: string; name: string }) =>
      api(`/api/agent-sessions/${input.sessionId}`, {
        method: "PATCH",
        body: JSON.stringify({ displayName: input.name }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const startError = startSession.error instanceof Error ? startSession.error.message : null;
  return (
    <>
      <div className="stage-tabbar">
        <div className="stage-tabs">
          {tabs.map((tab) => {
            const isActive = tab.session.id === activeSession?.session.id;
            return (
              <div key={tab.session.id} className={`stage-tab ${isActive ? "active" : ""}`}>
                <button
                  type="button"
                  onClick={() => props.onActiveSession(tab.session.id)}
                  onDoubleClick={() => {
                    setEditingId(tab.session.id);
                    setDraft(tab.label);
                  }}
                  aria-label={`Switch to ${tab.label}`}
                  title={`Switch to ${tab.label} (double-click to rename)`}
                  style={{ background: "transparent", border: 0, color: "inherit", cursor: "pointer", padding: 0 }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                    <TerminalSquare size={12} />
                    {editingId === tab.session.id ? (
                      <input
                        ref={(node) => {
                          if (node && editingId === tab.session.id && document.activeElement !== node) {
                            node.focus();
                            node.select();
                          }
                        }}
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={() => {
                          if (draft.trim() && draft.trim() !== tab.label) {
                            renameSession.mutate({ sessionId: tab.session.id, name: draft.trim() });
                          }
                          setEditingId(null);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                          if (event.key === "Escape") setEditingId(null);
                        }}
                      />
                    ) : (
                      <span>{tab.label}</span>
                    )}
                  </span>
                </button>
                <button
                  type="button"
                  className="close-tab"
                  aria-label="Stop session"
                  onClick={() => stopSession.mutate(tab.session.id)}
                  title="Stop session"
                >
                  <X size={11} />
                </button>
              </div>
            );
          })}
        </div>
        <div className="stage-add-wrapper" ref={addMenuRef}>
          <button
            type="button"
            className="stage-add"
            onClick={() => setAddMenuOpen((v) => !v)}
            aria-label="Add session"
            aria-haspopup="menu"
            aria-expanded={addMenuOpen}
            title="Add session"
            disabled={startSession.isPending}
          >
            <Plus size={14} />
          </button>
          {addMenuOpen ? (
            <div className="stage-add-menu" role="menu">
              <div className="stage-add-menu-label">New session</div>
              <button
                type="button"
                role="menuitem"
                title="Start a shell terminal in this workspace"
                onClick={() => startSession.mutate({ runtimeId: "shell", displayName: "Terminal" })}
                disabled={startSession.isPending}
              >
                <TerminalSquare size={12} /> Plain Terminal
              </button>
              {props.runtimes
                .filter((runtime) => runtime.id !== "shell")
                .map((runtime) => (
                  <button
                    key={runtime.id}
                    type="button"
                    role="menuitem"
                    disabled={runtime.health !== "healthy" || startSession.isPending}
                    title={
                      runtime.health === "healthy"
                        ? `Start ${runtime.displayName}`
                        : `${runtime.displayName} is ${runtime.health}${runtime.healthReason ? ` · ${runtime.healthReason}` : ""}`
                    }
                    onClick={() => startSession.mutate({ runtimeId: runtime.id, displayName: runtime.displayName })}
                  >
                    {runtime.displayName} ·{" "}
                    <span className={`stage-add-health ${runtime.health}`}>{runtime.health}</span>
                  </button>
                ))}
              {props.runtimes.filter((runtime) => runtime.id !== "shell").length === 0 ? (
                <div className="stage-add-empty">
                  No agents configured. <a href="/settings">Open settings</a> to add one.
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="stage-tabbar-spacer" aria-hidden />
      </div>
      {startError ? (
        <div className="stage-error" role="alert">
          Failed to start session: {startError}
        </div>
      ) : null}
      <div className="stage-body">
        {visitedPanes.map((session) => (
          <div
            key={session.id}
            className={session.id === activeSession?.session.id ? "terminal-active" : "terminal-hidden"}
          >
            <TerminalPane session={session} />
          </div>
        ))}
        {tabs.length === 0 ? (
          keepPending ? (
            <div className="empty">Starting session…</div>
          ) : (
            <div className="empty">No session yet. Click the plus to start a terminal or agent.</div>
          )
        ) : null}
      </div>
    </>
  );
}
