import type { AgentRuntime, TerminalProfile, Workspace, WorkspaceSession } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import { ExternalLink, Plus, RefreshCw, TerminalSquare, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, queryClient } from "./api.js";
import {
  applySessionOrder,
  loadSessionOrder,
  pruneSessionOrder,
  saveSessionOrder,
  spliceSessionOrder,
} from "./stage-session-order.js";
import { TerminalPane, getTerminalHandle, subscribeTerminalHandle } from "./terminal-pane.js";

type StageTab = {
  session: WorkspaceSession;
  label: string;
};

// Each daemon allocates 20 ttyd ports (one per active terminal) — see the
// per-daemon ttyd slice in apps/daemon/src/app.ts. We cap per workspace at
// the same number so the UI never lets the user create a session that
// would inevitably fail to bind a terminal port.
const WORKSPACE_SESSION_CAP = 20;
const SESSION_REORDER_MIME = "application/x-citadel-agent-session-reorder";
export const TERMINAL_PANE_RETAIN_LIMIT = 5;

function compareStageSessions(a: WorkspaceSession, b: WorkspaceSession) {
  const aKey = a.tabId ?? a.id;
  const bKey = b.tabId ?? b.id;
  const cmp = aKey.localeCompare(bKey);
  return cmp !== 0 ? cmp : a.createdAt.localeCompare(b.createdAt);
}

export function stableVisitedSessions(allSessions: WorkspaceSession[], visitedIds: Set<string>): WorkspaceSession[] {
  const byId = new Map(allSessions.map((session) => [session.id, session]));
  const result: WorkspaceSession[] = [];
  for (const id of visitedIds) {
    const session = byId.get(id);
    if (session) result.push(session);
  }
  return result;
}

export function retainRecentTerminalIds(
  visitedIds: Set<string>,
  activeId: string | null | undefined,
  liveIds: Set<string>,
  limit = TERMINAL_PANE_RETAIN_LIMIT,
): Set<string> {
  const safeLimit = Math.max(1, Math.trunc(limit));
  const ordered: string[] = [];
  for (const id of visitedIds) {
    if (!liveIds.has(id) || id === activeId) continue;
    ordered.push(id);
  }
  if (activeId && liveIds.has(activeId)) ordered.push(activeId);
  return new Set(ordered.slice(-safeLimit));
}

export function stableWorkspaceSessionIdsKey(sessions: WorkspaceSession[]): string {
  return [...sessions]
    .sort(compareStageSessions)
    .map((session) => session.id)
    .join("\0");
}

function sameOrderedIds(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  const aIds = [...a];
  const bIds = [...b];
  for (let i = 0; i < aIds.length; i += 1) {
    if (aIds[i] !== bIds[i]) return false;
  }
  return true;
}

function releaseTerminalViewer(sessionId: string): void {
  void fetch(`/api/workspace-sessions/${encodeURIComponent(sessionId)}/terminal`, {
    method: "DELETE",
    keepalive: true,
  }).catch(() => {
    // Best-effort: eviction should never block switching tabs.
  });
}

export function Stage(props: {
  workspace: Workspace;
  sessions: WorkspaceSession[];
  allSessions?: WorkspaceSession[];
  runtimes: AgentRuntime[];
  terminal: TerminalProfile;
  activeSessionId: string | undefined;
  onActiveSession: (id: string) => void;
}) {
  // Sort by tabId (time-encoded by createId on the daemon side), with createdAt
  // as a stable tie-breaker for legacy rows whose tab_id pre-dates migration 11.
  // The point of tabId: when a session is restored via `claude --resume <uuid>`
  // the new row inherits the source row's tabId, so the restored tab appears
  // in the same slot the original lived in — sorting by createdAt instead would
  // jump the restored session to the end of the strip.
  const defaultSortedSessions = [...props.sessions].sort(compareStageSessions);
  const [sessionOrder, setSessionOrder] = useState<Record<string, string[]>>(() => loadSessionOrder());
  useEffect(() => saveSessionOrder(sessionOrder), [sessionOrder]);
  useEffect(() => {
    const live = new Set(
      props.allSessions?.map((session) => session.id) ?? props.sessions.map((session) => session.id),
    );
    setSessionOrder((prev) => pruneSessionOrder(prev, live));
  }, [props.allSessions, props.sessions]);
  const sortedSessions = applySessionOrder(defaultSortedSessions, sessionOrder[props.workspace.id]);
  const tabs: StageTab[] = sortedSessions.map((session) => ({ session, label: session.displayName }));
  const visibleTabIds = tabs.map((tab) => tab.session.id);
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

  // Keep a bounded LRU of TerminalPane instances alive across workspace/session
  // switches once the user has opened them. This preserves fast returns for the
  // most recent terminals without letting hidden iframes keep every ttyd/tmux
  // viewer attached forever.
  const [visitedIds, setVisitedIds] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (props.activeSessionId) initial.add(props.activeSessionId);
    return initial;
  });
  const retainedIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const activeId = activeSession?.session.id ?? null;
    setVisitedIds((prev) => {
      const live = new Set(allSessions.map((session) => session.id));
      const next = retainRecentTerminalIds(prev, activeId, live);
      return sameOrderedIds(prev, next) ? prev : next;
    });
  }, [activeSession?.session.id, allSessions]);
  useEffect(() => {
    const previous = retainedIdsRef.current;
    retainedIdsRef.current = visitedIds;
    for (const id of previous) {
      if (!visitedIds.has(id)) releaseTerminalViewer(id);
    }
  }, [visitedIds]);
  const visitedPanes = stableVisitedSessions(allSessions, visitedIds);
  const workspaceSessionIdsKey = stableWorkspaceSessionIdsKey(props.sessions);

  useEffect(() => {
    if (!workspaceSessionIdsKey) return;
    const sessionIds = workspaceSessionIdsKey.split("\0").filter(Boolean);
    const timer = window.setTimeout(() => {
      for (const sessionId of sessionIds) {
        getTerminalHandle(sessionId)?.recoverIfDisconnected();
      }
    }, 150);
    return () => window.clearTimeout(timer);
  }, [workspaceSessionIdsKey]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [tabDropIndicator, setTabDropIndicator] = useState<{ id: string; side: "before" | "after" } | null>(null);
  const addMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!addMenuOpen) return;
    const onClick = (event: MouseEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node)) setAddMenuOpen(false);
    };
    window.addEventListener("mousedown", onClick);
    return () => window.removeEventListener("mousedown", onClick);
  }, [addMenuOpen]);

  const startAgentSession = useMutation({
    mutationFn: (input: { runtimeId: string; displayName: string }) =>
      api<{ session: WorkspaceSession }>("/api/agent-sessions", {
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

  const startTerminalSession = useMutation({
    mutationFn: () =>
      api<{ session: WorkspaceSession }>(`/api/workspaces/${props.workspace.id}/terminal-sessions`, {
        method: "POST",
        body: JSON.stringify({ displayName: props.terminal.displayName }),
      }),
    onSuccess: ({ session }) => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      props.onActiveSession(session.id);
      setAddMenuOpen(false);
    },
  });

  const stopSession = useMutation({
    mutationFn: (sessionId: string) => api(`/api/workspace-sessions/${sessionId}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const renameSession = useMutation({
    mutationFn: (input: { sessionId: string; name: string }) =>
      api(`/api/workspace-sessions/${input.sessionId}`, {
        method: "PATCH",
        body: JSON.stringify({ displayName: input.name }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  // Tick whenever any TerminalPane updates its handle so the tab actions
  // (refresh, open-in-new-tab) reflect the current URL + reload callback.
  const [, setHandleTick] = useState(0);
  useEffect(() => subscribeTerminalHandle(() => setHandleTick((n) => n + 1)), []);

  const startError =
    startAgentSession.error instanceof Error
      ? startAgentSession.error.message
      : startTerminalSession.error instanceof Error
        ? startTerminalSession.error.message
        : null;
  const atSessionCap = props.sessions.length >= WORKSPACE_SESSION_CAP;
  // Per spec B.2 §Center Stage Sessions #10: starting a session needs a
  // ready worktree, so the "+" button is gated off while the workspace is
  // still being provisioned. AC3 (async create) will surface this state
  // visibly on the card; today the lifecycle is briefly "creating" only
  // during the synchronous setup window.
  const lifecycleCreating = props.workspace.lifecycle === "creating";
  const addDisabled =
    startAgentSession.isPending || startTerminalSession.isPending || atSessionCap || lifecycleCreating;
  const addTitle = atSessionCap
    ? `Workspace is at the ${WORKSPACE_SESSION_CAP}-session cap. Close a session to start another.`
    : lifecycleCreating
      ? "Workspace is still being set up."
      : "Add session";
  return (
    <>
      <div className="stage-tabbar">
        <div className="stage-tabs">
          {tabs.map((tab, index) => {
            const isActive = tab.session.id === activeSession?.session.id;
            const isRunning = tab.session.status === "running";
            const dropSide = tabDropIndicator?.id === tab.session.id ? tabDropIndicator.side : null;
            return (
              <div
                key={tab.session.id}
                className={`stage-tab ${isActive ? "active" : ""} ${
                  dropSide === "before" ? "is-drop-before" : dropSide === "after" ? "is-drop-after" : ""
                }`}
                draggable={editingId !== tab.session.id}
                onDragStart={(event) => {
                  event.dataTransfer.setData(SESSION_REORDER_MIME, tab.session.id);
                  event.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(event) => {
                  if (!event.dataTransfer.types.includes(SESSION_REORDER_MIME)) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  const rect = event.currentTarget.getBoundingClientRect();
                  const midpoint = rect.left + rect.width / 2;
                  setTabDropIndicator({ id: tab.session.id, side: event.clientX < midpoint ? "before" : "after" });
                }}
                onDragLeave={() => setTabDropIndicator(null)}
                onDrop={(event) => {
                  if (!event.dataTransfer.types.includes(SESSION_REORDER_MIME)) return;
                  event.preventDefault();
                  const draggedId = event.dataTransfer.getData(SESSION_REORDER_MIME);
                  if (!draggedId || draggedId === tab.session.id) {
                    setTabDropIndicator(null);
                    return;
                  }
                  const targetIndex = visibleTabIds.indexOf(tab.session.id);
                  if (targetIndex === -1) {
                    setTabDropIndicator(null);
                    return;
                  }
                  const insertIndex = tabDropIndicator?.side === "after" ? targetIndex + 1 : targetIndex;
                  setSessionOrder((prev) => ({
                    ...prev,
                    [props.workspace.id]: spliceSessionOrder(visibleTabIds, draggedId, insertIndex),
                  }));
                  setTabDropIndicator(null);
                }}
              >
                <button
                  type="button"
                  onClick={() => props.onActiveSession(tab.session.id)}
                  onDoubleClick={() => {
                    setEditingId(tab.session.id);
                    setDraft(tab.label);
                  }}
                  aria-label={`Switch to ${tab.label}`}
                  title={`Switch to ${tab.label} (double-click to rename)`}
                  className="stage-tab-button"
                >
                  <span className="stage-tab-inner">
                    {index < 9 ? (
                      <kbd className="stage-tab-kbd" title={`Shift+${index + 1}`}>
                        ⇧{index + 1}
                      </kbd>
                    ) : null}
                    <span className="stage-tab-icon" aria-hidden>
                      <span className={`cit-pulse cit-pulse-sm ${isRunning ? "cit-pulse-run" : "cit-pulse-idle"}`} />
                    </span>
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
                      <span className="stage-tab-label">{tab.label}</span>
                    )}
                  </span>
                </button>
                <span className="stage-tab-actions">
                  <button
                    type="button"
                    className="stage-tab-act"
                    aria-label="Restart terminal session"
                    title="Restart session"
                    onClick={(event) => {
                      event.stopPropagation();
                      getTerminalHandle(tab.session.id)?.reload();
                    }}
                  >
                    <RefreshCw size={11} />
                  </button>
                  <button
                    type="button"
                    className="stage-tab-act"
                    aria-label="Open terminal in standalone tab"
                    title="Open in standalone tab"
                    disabled={!getTerminalHandle(tab.session.id)?.url}
                    onClick={(event) => {
                      event.stopPropagation();
                      const handle = getTerminalHandle(tab.session.id);
                      if (handle?.url) window.open(handle.url, "_blank");
                    }}
                  >
                    <ExternalLink size={11} />
                  </button>
                  <button
                    type="button"
                    className="close-tab"
                    aria-label="Stop session"
                    onClick={(event) => {
                      event.stopPropagation();
                      // Pre-pick the next active tab BEFORE mutating so the
                      // 4s `keepPending` grace never opens a blank window on
                      // close. Prefer the LEFT sibling; fall back to the
                      // right sibling. If this is the only tab, leave the
                      // active pointer alone (Stage falls back to "no
                      // session yet" empty state).
                      if (tab.session.id === activeSession?.session.id && tabs.length > 1) {
                        const next = tabs[index - 1] ?? tabs[index + 1];
                        if (next) props.onActiveSession(next.session.id);
                      }
                      stopSession.mutate(tab.session.id);
                    }}
                    title="Stop session"
                  >
                    <X size={11} />
                  </button>
                </span>
              </div>
            );
          })}
        </div>
        <div className="stage-add-wrapper" ref={addMenuRef}>
          <button
            type="button"
            className="stage-add"
            onClick={() => setAddMenuOpen((v) => !v)}
            aria-label={addTitle}
            aria-haspopup="menu"
            aria-expanded={addMenuOpen}
            title={addTitle}
            disabled={addDisabled}
          >
            <Plus size={14} />
          </button>
          {addMenuOpen ? (
            <div className="stage-add-menu" role="menu">
              <div className="stage-add-menu-label">
                New session
                {atSessionCap ? (
                  <output className="stage-add-cap">
                    {props.sessions.length}/{WORKSPACE_SESSION_CAP} — cap reached
                  </output>
                ) : null}
              </div>
              <button
                type="button"
                role="menuitem"
                title={
                  atSessionCap
                    ? `Cap reached (${WORKSPACE_SESSION_CAP}). Close a session first.`
                    : "Start a terminal in this workspace"
                }
                onClick={() => startTerminalSession.mutate()}
                disabled={addDisabled}
              >
                <TerminalSquare size={12} /> {props.terminal.displayName}
              </button>
              {props.runtimes.map((runtime) => {
                const runtimeDisabled = runtime.health !== "healthy" || addDisabled;
                const runtimeTitle = atSessionCap
                  ? `Cap reached (${WORKSPACE_SESSION_CAP}). Close a session first.`
                  : runtime.health === "healthy"
                    ? `Start ${runtime.displayName}`
                    : `${runtime.displayName} is ${runtime.health}${runtime.healthReason ? ` · ${runtime.healthReason}` : ""}`;
                return (
                  <button
                    key={runtime.id}
                    type="button"
                    role="menuitem"
                    disabled={runtimeDisabled}
                    title={runtimeTitle}
                    onClick={() =>
                      startAgentSession.mutate({ runtimeId: runtime.id, displayName: runtime.displayName })
                    }
                  >
                    {runtime.displayName} ·{" "}
                    <span className={`stage-add-health ${runtime.health}`}>{runtime.health}</span>
                  </button>
                );
              })}
              {props.runtimes.length === 0 ? (
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
