import type { AgentRuntime, RoleTemplate, TerminalProfile, Workspace, WorkspaceSession } from "@citadel/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { api, queryClient } from "./api.js";
import { type AttentionSessionIds, deriveSessionDisplayLifecycleTone } from "./session-status-display.js";
import { StageEmptyLauncher, StageLaunchEntryIcon } from "./stage-empty-launcher.js";
import {
  type StageDirectRoleAction,
  type StageLaunchEntry,
  type StageStructuredAction,
  WORKSPACE_SESSION_CAP,
  buildStageLaunchEntryGroups,
  freestyleStageActions,
  structuredStageActions,
} from "./stage-launch-actions.js";
import {
  applySessionOrder,
  loadSessionOrder,
  pruneSessionOrder,
  replaceSessionOrderId,
  saveSessionOrder,
  spliceSessionOrder,
} from "./stage-session-order.js";
import { StageTabActionMenu } from "./stage-tab-menu.js";
import { TerminalPane, getTerminalHandle } from "./terminal-pane.js";
import { lifecycleToneClass } from "./workspace-card.js";

type StageTab = {
  session: WorkspaceSession;
  label: string;
};

type PendingReload = {
  source: WorkspaceSession;
  replacement?: WorkspaceSession;
};

type PendingReloads = Record<string, PendingReload>;
const SESSION_REORDER_MIME = "application/x-citadel-agent-session-reorder";
export const TERMINAL_PANE_RETAIN_LIMIT = 5;

function compareStageSessions(a: WorkspaceSession, b: WorkspaceSession) {
  const aKey = a.tabId ?? a.id;
  const bKey = b.tabId ?? b.id;
  const cmp = aKey.localeCompare(bKey);
  return cmp !== 0 ? cmp : a.createdAt.localeCompare(b.createdAt);
}

export function stageTabIdentity(session: WorkspaceSession): string {
  return session.tabId ?? session.id;
}

export function applyPendingReloadSessions(
  sessions: readonly WorkspaceSession[],
  pendingReloads: PendingReloads,
): WorkspaceSession[] {
  const next = sessions.slice();
  for (const pending of Object.values(pendingReloads)) {
    const display = pending.replacement ?? pending.source;
    const tabId = stageTabIdentity(display);
    const existingIndex = next.findIndex((session) => stageTabIdentity(session) === tabId);
    if (existingIndex === -1) {
      next.push(display);
      continue;
    }
    if (pending.replacement || next[existingIndex]?.closedAt) next[existingIndex] = display;
  }
  return next;
}

function pendingReloadTabIdentity(pendingReloads: PendingReloads, sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  const direct = pendingReloads[sessionId];
  if (direct) return stageTabIdentity(direct.replacement ?? direct.source);
  for (const pending of Object.values(pendingReloads)) {
    if (pending.replacement?.id === sessionId) return stageTabIdentity(pending.replacement);
  }
  return null;
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

export function Stage(props: {
  workspace: Workspace;
  sessions: WorkspaceSession[];
  allSessions?: WorkspaceSession[];
  targetKey: string;
  targetType: "workspace_home" | "worktree_checkout";
  checkoutId: string | null;
  targetLabel: string;
  runtimes: AgentRuntime[];
  terminal: TerminalProfile;
  activeSessionId: string | undefined;
  onActiveSession: (id: string) => void;
  unseenAttentionSessionIds?: AttentionSessionIds | undefined;
}) {
  const [pendingReloads, setPendingReloads] = useState<PendingReloads>({});
  const renderedSessions = useMemo(
    () => applyPendingReloadSessions(props.sessions, pendingReloads),
    [props.sessions, pendingReloads],
  );
  const renderedAllSessions = useMemo(
    () => applyPendingReloadSessions(props.allSessions ?? props.sessions, pendingReloads),
    [props.allSessions, props.sessions, pendingReloads],
  );

  // Sort by tabId (time-encoded by createId on the daemon side), with createdAt
  // as a stable tie-breaker for legacy rows whose tab_id pre-dates migration 11.
  // The point of tabId: when a session is restored via `claude --resume <uuid>`
  // the new row inherits the source row's tabId, so the restored tab appears
  // in the same slot the original lived in — sorting by createdAt instead would
  // jump the restored session to the end of the strip.
  const defaultSortedSessions = [...renderedSessions].sort(compareStageSessions);
  const [sessionOrder, setSessionOrder] = useState<Record<string, string[]>>(() => loadSessionOrder());
  useEffect(() => saveSessionOrder(sessionOrder), [sessionOrder]);
  useEffect(() => {
    const live = new Set(
      renderedAllSessions
        .filter((session) => !session.closedAt)
        .flatMap((session) => [session.id, stageTabIdentity(session)]),
    );
    setSessionOrder((prev) => pruneSessionOrder(prev, live));
  }, [renderedAllSessions]);
  useEffect(() => {
    const visibleSessionIds = new Set(props.sessions.map((session) => session.id));
    setPendingReloads((prev) => {
      let changed = false;
      const next: PendingReloads = {};
      for (const [sourceId, pending] of Object.entries(prev)) {
        if (pending.replacement && visibleSessionIds.has(pending.replacement.id)) {
          changed = true;
          continue;
        }
        next[sourceId] = pending;
      }
      return changed ? next : prev;
    });
  }, [props.sessions]);
  const orderKey = `${props.workspace.id}:${props.targetKey}`;
  const sortedSessions = applySessionOrder(defaultSortedSessions, sessionOrder[orderKey], stageTabIdentity);
  const tabs: StageTab[] = sortedSessions.map((session) => ({ session, label: session.displayName }));
  const visibleTabIds = tabs.map((tab) => stageTabIdentity(tab.session));
  const liveSessions = useMemo(() => renderedAllSessions.filter((session) => !session.closedAt), [renderedAllSessions]);

  // If the caller just selected a session that hasn't shown up in props.sessions
  // yet (mutation responded, query refetch in flight), keep that ID even though
  // it's not in `tabs` — otherwise we'd snap focus back to tabs[0] and clobber
  // the user's selection (e.g. right after starting a new agent). After a short
  // grace period (e.g. persisted ID from localStorage that no longer exists),
  // fall back to the first tab.
  const activeReloadTabIdentity = pendingReloadTabIdentity(pendingReloads, props.activeSessionId);
  const pendingActiveSessionId =
    props.activeSessionId &&
    !tabs.some((tab) => tab.session.id === props.activeSessionId) &&
    !(activeReloadTabIdentity && tabs.some((tab) => stageTabIdentity(tab.session) === activeReloadTabIdentity))
      ? props.activeSessionId
      : null;
  const [graceExpired, setGraceExpired] = useState(false);
  useEffect(() => {
    if (!pendingActiveSessionId) {
      setGraceExpired(false);
      return;
    }
    setGraceExpired(false);
    const timeout = window.setTimeout(() => setGraceExpired(true), 4000);
    return () => window.clearTimeout(timeout);
  }, [pendingActiveSessionId]);
  const keepPending = Boolean(pendingActiveSessionId) && !graceExpired;
  const activeSession = keepPending
    ? null
    : (tabs.find((tab) => tab.session.id === props.activeSessionId) ??
      (activeReloadTabIdentity
        ? tabs.find((tab) => stageTabIdentity(tab.session) === activeReloadTabIdentity)
        : undefined) ??
      tabs[0] ??
      null);
  useEffect(() => {
    if (keepPending) return;
    if (activeSession && activeSession.session.id !== props.activeSessionId) {
      props.onActiveSession(activeSession.session.id);
    }
  }, [activeSession, keepPending, props]);

  // Keep a bounded LRU of TerminalPane shells mounted across workspace/session
  // switches once the user has opened them. Hidden panes are passed active=false
  // so they do not keep xterm/WebSocket viewers alive and render background
  // output on the same main thread as the active terminal input path.
  const [visitedIds, setVisitedIds] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    if (props.activeSessionId) initial.add(props.activeSessionId);
    return initial;
  });
  useEffect(() => {
    const activeId = activeSession?.session.id ?? null;
    setVisitedIds((prev) => {
      const live = new Set(liveSessions.map((session) => session.id));
      const next = retainRecentTerminalIds(prev, activeId, live);
      return sameOrderedIds(prev, next) ? prev : next;
    });
  }, [activeSession?.session.id, liveSessions]);
  const visiblePaneIds = activeSession ? new Set([...visitedIds, activeSession.session.id]) : visitedIds;
  const visitedPanes = stableVisitedSessions(liveSessions, visiblePaneIds);
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
          targetType: props.targetType,
          ...(props.checkoutId ? { checkoutId: props.checkoutId } : {}),
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
        body: JSON.stringify({
          displayName: props.terminal.displayName,
          targetType: props.targetType,
          ...(props.checkoutId ? { checkoutId: props.checkoutId } : {}),
        }),
      }),
    onSuccess: ({ session }) => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      props.onActiveSession(session.id);
      setAddMenuOpen(false);
    },
  });

  const agentTemplates = useQuery({
    queryKey: ["agent-templates"],
    queryFn: () => api<{ roles: RoleTemplate[] }>("/api/agent-templates"),
    staleTime: 30_000,
  });

  const startDirectRoleSession = useMutation({
    mutationFn: (action: StageDirectRoleAction) =>
      api<{ session: WorkspaceSession }>("/api/agent-sessions", {
        method: "POST",
        body: JSON.stringify({
          workspaceId: props.workspace.id,
          targetType: props.targetType,
          ...(props.checkoutId ? { checkoutId: props.checkoutId } : {}),
          runtimeId: action.template.launchSettings.runtimeId,
          displayName: action.template.displayName,
          role: action.template.role,
          managed: true,
          launchSettings: action.template.launchSettings,
        }),
      }),
    onSuccess: ({ session }) => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      props.onActiveSession(session.id);
      setAddMenuOpen(false);
    },
  });

  const startStructuredAction = useMutation({
    mutationFn: async (action: StageStructuredAction) => {
      const response = await api<{ result: StructuredToolResult }>("/api/mcp/tools/call", {
        method: "POST",
        body: JSON.stringify({ name: action.toolName, arguments: action.arguments }),
      });
      if (response.result?.error || response.result?.ok === false) {
        throw new Error(structuredToolError(response.result));
      }
      return response.result;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      if (result.session?.id) props.onActiveSession(result.session.id);
      setAddMenuOpen(false);
    },
  });

  const stopSession = useMutation({
    mutationFn: (sessionId: string) => api(`/api/workspace-sessions/${sessionId}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const reloadAgentSession = useMutation({
    mutationFn: (session: WorkspaceSession) =>
      api<{ session: WorkspaceSession; reloadedFrom: string }>(`/api/agent-sessions/${session.id}/reload`, {
        method: "POST",
      }),
    onMutate: (session) => {
      setPendingReloads((prev) => ({ ...prev, [session.id]: { source: session } }));
    },
    onSuccess: ({ session, reloadedFrom }) => {
      setPendingReloads((prev) => ({
        ...prev,
        [reloadedFrom]: { source: prev[reloadedFrom]?.source ?? session, replacement: session },
      }));
      queryClient.invalidateQueries({ queryKey: ["state"] });
      setSessionOrder((prev) => {
        const current = prev[orderKey];
        if (!current?.includes(reloadedFrom)) return prev;
        return { ...prev, [orderKey]: replaceSessionOrderId(current, reloadedFrom, stageTabIdentity(session)) };
      });
      props.onActiveSession(session.id);
    },
    onError: (_error, session) => {
      setPendingReloads((prev) => {
        const { [session.id]: _removed, ...next } = prev;
        return next;
      });
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  const renameSession = useMutation({
    mutationFn: (input: { sessionId: string; name: string }) =>
      api(`/api/workspace-sessions/${input.sessionId}`, {
        method: "PATCH",
        body: JSON.stringify({ displayName: input.name }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const startError =
    startAgentSession.error instanceof Error
      ? startAgentSession.error.message
      : startTerminalSession.error instanceof Error
        ? startTerminalSession.error.message
        : startDirectRoleSession.error instanceof Error
          ? startDirectRoleSession.error.message
          : startStructuredAction.error instanceof Error
            ? startStructuredAction.error.message
            : null;
  const reloadError = reloadAgentSession.error instanceof Error ? reloadAgentSession.error.message : null;
  const atSessionCap = props.sessions.length >= WORKSPACE_SESSION_CAP;
  // Per spec B.2 §Center Stage Sessions #10: starting a session needs a
  // ready worktree, so the "+" button is gated off while the workspace is
  // still being provisioned. AC3 (async create) will surface this state
  // visibly on the card; today the lifecycle is briefly "creating" only
  // during the synchronous setup window.
  const lifecycleCreating = props.workspace.lifecycle === "creating";
  const addDisabled =
    startAgentSession.isPending ||
    startTerminalSession.isPending ||
    startDirectRoleSession.isPending ||
    startStructuredAction.isPending ||
    atSessionCap ||
    lifecycleCreating;
  const addTitle = atSessionCap
    ? `Workspace is at the ${WORKSPACE_SESSION_CAP}-session cap. Close a session to start another.`
    : lifecycleCreating
      ? "Workspace is still being set up."
      : "Add session";
  const structuredActions = structuredStageActions({
    workspace: props.workspace,
    targetType: props.targetType,
    checkoutId: props.checkoutId,
  });
  const directRoleActions = freestyleStageActions({
    workspace: props.workspace,
    templates: agentTemplates.data?.roles ?? [],
  });
  const launchGroups = buildStageLaunchEntryGroups({
    structuredActions,
    directRoleActions,
    terminal: props.terminal,
    runtimes: props.runtimes,
    addDisabled,
    atSessionCap,
  });
  const resumableRuntimeIds = useMemo(
    () => new Set(props.runtimes.filter((runtime) => runtime.capabilities.supportsResume).map((runtime) => runtime.id)),
    [props.runtimes],
  );
  const launchEntry = (entry: StageLaunchEntry) => {
    if (entry.disabled) return;
    if (entry.type === "structured") {
      startStructuredAction.mutate(entry.action);
      return;
    }
    if (entry.type === "direct-role") {
      startDirectRoleSession.mutate(entry.action);
      return;
    }
    if (entry.type === "terminal") {
      startTerminalSession.mutate();
      return;
    }
    startAgentSession.mutate({ runtimeId: entry.runtime.id, displayName: entry.runtime.displayName });
  };
  return (
    <>
      <div className="stage-tabbar">
        <div className="stage-tabs">
          {tabs.map((tab, index) => {
            const isActive = tab.session.id === activeSession?.session.id;
            const lifecycleTone = deriveSessionDisplayLifecycleTone(tab.session, props.unseenAttentionSessionIds);
            const dropSide = tabDropIndicator?.id === tab.session.id ? tabDropIndicator.side : null;
            return (
              <div
                key={stageTabIdentity(tab.session)}
                className={`stage-tab ${isActive ? "active" : ""} ${
                  dropSide === "before" ? "is-drop-before" : dropSide === "after" ? "is-drop-after" : ""
                }`}
                draggable={editingId !== tab.session.id}
                onDragStart={(event) => {
                  event.dataTransfer.setData(SESSION_REORDER_MIME, stageTabIdentity(tab.session));
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
                  if (!draggedId || draggedId === stageTabIdentity(tab.session)) {
                    setTabDropIndicator(null);
                    return;
                  }
                  const targetIndex = visibleTabIds.indexOf(stageTabIdentity(tab.session));
                  if (targetIndex === -1) {
                    setTabDropIndicator(null);
                    return;
                  }
                  const insertIndex = tabDropIndicator?.side === "after" ? targetIndex + 1 : targetIndex;
                  setSessionOrder((prev) => ({
                    ...prev,
                    [orderKey]: spliceSessionOrder(visibleTabIds, draggedId, insertIndex),
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
                      <span className={`cit-pulse cit-pulse-sm ${lifecycleToneClass(lifecycleTone)}`} />
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
                      <>
                        {tab.session.role ? <span className="stage-tab-role">{tab.session.role}</span> : null}
                        <span className="stage-tab-label">{tab.label}</span>
                      </>
                    )}
                  </span>
                </button>
                <StageTabActionMenu
                  session={tab.session}
                  label={tab.label}
                  canReloadAgentSession={
                    tab.session.kind === "agent" &&
                    Boolean(tab.session.runtimeSessionId) &&
                    resumableRuntimeIds.has(tab.session.runtimeId)
                  }
                  reloadingAgentSession={reloadAgentSession.isPending}
                  onReloadTerminal={() => getTerminalHandle(tab.session.id)?.reload()}
                  onReloadAgentSession={() => reloadAgentSession.mutate(tab.session)}
                  onStopSession={() => {
                    // Pre-pick the next active tab before mutation so the
                    // keepPending grace never opens a blank window on close.
                    if (tab.session.id === activeSession?.session.id && tabs.length > 1) {
                      const next = tabs[index - 1] ?? tabs[index + 1];
                      if (next) props.onActiveSession(next.session.id);
                    }
                    stopSession.mutate(tab.session.id);
                  }}
                />
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
                New session in {props.targetLabel}
                {atSessionCap ? (
                  <output className="stage-add-cap">
                    {props.sessions.length}/{WORKSPACE_SESSION_CAP} — cap reached
                  </output>
                ) : null}
              </div>
              {launchGroups.map((group) => (
                <Fragment key={group.id}>
                  <div className="stage-add-menu-label">{group.label}</div>
                  {group.entries.map((entry) => (
                    <button
                      key={entry.id}
                      type="button"
                      role="menuitem"
                      title={entry.title}
                      onClick={() => launchEntry(entry)}
                      disabled={entry.disabled}
                    >
                      <StageLaunchEntryIcon entry={entry} size={12} />
                      {entry.label}
                      {entry.detail ? (
                        <>
                          {" "}
                          · <span className={`stage-add-health ${entry.detail}`}>{entry.detail}</span>
                        </>
                      ) : null}
                    </button>
                  ))}
                </Fragment>
              ))}
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
      {startError || reloadError ? (
        <div className="stage-error" role="alert">
          {startError ? `Failed to start session: ${startError}` : `Failed to reload session: ${reloadError}`}
        </div>
      ) : null}
      <div className="stage-body">
        {visitedPanes.map((session) => (
          <div
            key={stageTabIdentity(session)}
            className={session.id === activeSession?.session.id ? "terminal-active" : "terminal-hidden"}
          >
            <TerminalPane session={session} active={session.id === activeSession?.session.id} />
          </div>
        ))}
        {tabs.length === 0 ? (
          keepPending ? (
            <div className="empty">Starting session…</div>
          ) : (
            <StageEmptyLauncher
              targetLabel={props.targetLabel}
              groups={launchGroups}
              runtimesCount={props.runtimes.length}
              onLaunch={launchEntry}
            />
          )
        ) : null}
      </div>
    </>
  );
}

type StructuredToolResult = {
  ok?: boolean;
  error?: string;
  detail?: string;
  session?: WorkspaceSession;
};

function structuredToolError(result: StructuredToolResult): string {
  return result.detail
    ? `${result.error ?? "structured_action_failed"}: ${result.detail}`
    : (result.error ?? "structured_action_failed");
}
