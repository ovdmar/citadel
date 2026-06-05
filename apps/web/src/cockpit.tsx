import type { PullRequestSummary, Workspace, WorkspaceSession } from "@citadel/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { ChevronsLeft, Search as SearchIcon, Settings as SettingsIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api.js";
import { useEventRefresh, useFilteredStateQuery } from "./app-state.js";
import { BottomBar } from "./cockpit-bottom-bar.js";
import { CollapsedLeftRail } from "./cockpit-rails.js";
import { readinessForWorkspace } from "./cockpit-readiness.js";
import {
  checkoutIdFromTargetKey,
  sessionMatchesTarget,
  shouldShowInspectorPanel,
  targetKeyForSession,
  targetLabel,
} from "./cockpit-session-targets.js";
import { resolveShortcutAction } from "./cockpit-shortcut-actions.js";
import {
  invalidateActiveWorkspaceFromBatch,
  prMapFromSummaries,
  useAllWorkspacesPrSummary,
  useStickyWorkspaceSummaries,
  useWorkspaceCockpitSummary,
  useWorkspacesPrState,
} from "./cockpit-tools.js";
import { CommandPalette } from "./command-palette.js";
import { GhCooldownBanner } from "./gh-cooldown-banner.js";
import { useFocusRefresh } from "./hooks/use-focus-refresh.js";
import { Inspector } from "./inspector.js";
import {
  expandGroupPath,
  readNavigatorGrouping,
  subscribeToCollapseChanges,
  subscribeToGroupingChanges,
} from "./navigator-collapse-store.js";
import { buildGroupTree, flattenWorkspaceOrder, treeGroupingFor } from "./navigator-groups.js";
import { checkoutPrStateMap } from "./navigator-pr-state.js";
import { Navigator } from "./navigator.js";
import { RestoreBanner } from "./restore-banner.js";
import { type ShortcutMatch, matchShortcut } from "./shortcuts.js";
import { Stage } from "./stage.js";
import { focusActiveTerminal, isRegisteredTerminalMessageSource } from "./terminal-pane.js";
import { parseRegisteredTerminalShortcutMessage, terminalShortcutMatch } from "./terminal-shortcut-bridge.js";
import { ThemeControls } from "./theme-controls.js";
import { UsageIndicator } from "./usage-indicator.js";
import { startColumnDrag, useCockpitLayout } from "./use-cockpit-layout.js";
import { prToneFor } from "./workspace-card.js";

const STORAGE_LAST_WORKSPACE = "citadel.last-workspace";
const STORAGE_LAST_REPO = "citadel.last-repo";
const STORAGE_SESSION_BY_WORKSPACE = "citadel.session-by-workspace";
const STORAGE_TARGET_BY_WORKSPACE = "citadel.target-by-workspace";
const TERMINAL_FOCUS_DELAYS_MS = [0, 50, 160, 400];

type MobileView = "navigator" | "stage" | "inspector";

function focusTerminalSoon(sessionId: string) {
  for (const delay of TERMINAL_FOCUS_DELAYS_MS) {
    window.setTimeout(() => focusActiveTerminal(sessionId), delay);
  }
}

function homeReviewCheckoutId(
  workspace: Workspace | null,
  checkouts: Array<{
    id: string;
    repoId: string;
    path: string;
  }>,
): string | null {
  if (!workspace) return null;
  const exact = checkouts.find((checkout) => checkout.path === workspace.path && checkout.repoId === workspace.repoId);
  if (exact) return exact.id;
  return checkouts.length === 1 ? (checkouts[0]?.id ?? null) : null;
}

export function Cockpit() {
  // Use the filtered variant so workspaces in the optimistic-remove
  // blacklist (AC4) are subtracted from `data.workspaces` for every
  // consumer of `state.data` below — including the active-workspace
  // selector at L52, which must never pick a blacklisted workspace as
  // the fallback active row.
  const state = useFilteredStateQuery();
  useEventRefresh();
  const data = state.data;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = (useSearch({ strict: false }) ?? {}) as { workspace?: string };
  const location = useLocation();

  const layout = useCockpitLayout();
  const [activeWorkspaceId, setActiveWorkspaceId] = useLocalStorage(STORAGE_LAST_WORKSPACE, "");
  const [lastRepoId, setLastRepoId] = useLocalStorage(STORAGE_LAST_REPO, "");
  const [activeSessionByWorkspace, setActiveSessionByWorkspace] = useLocalStorageRecord(STORAGE_SESSION_BY_WORKSPACE);
  const [activeTargetByWorkspace, setActiveTargetByWorkspace] = useLocalStorageRecord(STORAGE_TARGET_BY_WORKSPACE);
  const [commandOpen, setCommandOpen] = useState(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [mobileView, setMobileView] = useState<MobileView>("stage");

  // Re-route search-param-driven workspace selection (used from dashboard/history)
  useEffect(() => {
    if (search.workspace) {
      setActiveWorkspaceId(search.workspace);
      setActiveTargetByWorkspace((current) => ({ ...current, [search.workspace as string]: "home" }));
      navigate({ to: location.pathname, search: {} as Record<string, string> });
    }
  }, [search.workspace, navigate, location.pathname, setActiveWorkspaceId, setActiveTargetByWorkspace]);

  const activeWorkspace = useMemo<Workspace | null>(() => {
    if (!data?.workspaces.length) return null;
    return (
      data.workspaces.find((workspace) => workspace.id === activeWorkspaceId) ??
      [...data.workspaces].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ??
      null
    );
  }, [activeWorkspaceId, data?.workspaces]);
  useEffect(() => {
    if (activeWorkspace && activeWorkspace.id !== activeWorkspaceId) setActiveWorkspaceId(activeWorkspace.id);
    if (activeWorkspace?.repoId && activeWorkspace.repoId !== lastRepoId) setLastRepoId(activeWorkspace.repoId);
  }, [activeWorkspace, activeWorkspaceId, lastRepoId, setActiveWorkspaceId, setLastRepoId]);

  const batchPrSummary = useAllWorkspacesPrSummary(data?.workspaces ?? []);
  const { summaries: stickySummaries, rememberSummary } = useStickyWorkspaceSummaries(
    data?.workspaces ?? [],
    batchPrSummary.data,
  );
  const placeholderSummary = activeWorkspace ? stickySummaries.get(activeWorkspace.id) : undefined;
  const cockpitSummary = useWorkspaceCockpitSummary(activeWorkspace, placeholderSummary);
  const prStateQuery = useWorkspacesPrState();
  useEffect(() => {
    if (cockpitSummary.data) rememberSummary(cockpitSummary.data);
  }, [cockpitSummary.data, rememberSummary]);
  useEffect(() => {
    invalidateActiveWorkspaceFromBatch(queryClient, activeWorkspace?.id, batchPrSummary.dataUpdatedAt);
  }, [activeWorkspace?.id, batchPrSummary.dataUpdatedAt, queryClient]);
  const focusConfig = useQuery({
    queryKey: ["config"],
    queryFn: () => api<{ config: { providerRefresh?: { focusRefreshThresholdMs?: number } } }>("/api/config"),
  });
  const focusThresholdMs = focusConfig.data?.config?.providerRefresh?.focusRefreshThresholdMs ?? 30_000;
  useFocusRefresh({
    workspaceId: activeWorkspace?.id ?? null,
    thresholdMs: focusThresholdMs,
    queryClient,
  });
  const prByWorkspaceId = useMemo(() => {
    const map = new Map<string, PullRequestSummary | null>();
    for (const [workspaceId, entry] of Object.entries(prStateQuery.data?.workspacePrState ?? {})) {
      map.set(workspaceId, entry.pullRequest ?? null);
    }
    for (const [workspaceId, pullRequest] of prMapFromSummaries(stickySummaries)) {
      map.set(workspaceId, pullRequest);
    }
    if (cockpitSummary.data?.versionControl.status === "healthy") {
      map.set(cockpitSummary.data.workspaceId, cockpitSummary.data.versionControl.pullRequest ?? null);
    }
    return map;
  }, [prStateQuery.data, stickySummaries, cockpitSummary.data]);
  const checkoutPrByWorkspaceId = useMemo(
    () => checkoutPrStateMap(prStateQuery.data?.checkoutPrState),
    [prStateQuery.data?.checkoutPrState],
  );
  const selectedRepo = activeWorkspace?.repoId
    ? (data?.repos.find((repo) => repo.id === activeWorkspace.repoId) ?? null)
    : (data?.repos[0] ?? null);
  const allSessions = data?.sessions ?? [];
  const allCheckouts = data?.checkouts ?? [];
  const activeWorkspaceCheckouts = activeWorkspace
    ? allCheckouts.filter((checkout) => checkout.workspaceId === activeWorkspace.id && !checkout.archivedAt)
    : [];
  const activeTargetKey = activeWorkspace ? (activeTargetByWorkspace[activeWorkspace.id] ?? "home") : "home";
  const activeCheckoutId = checkoutIdFromTargetKey(activeTargetKey, activeWorkspaceCheckouts);
  const reviewCheckoutId = activeCheckoutId ?? homeReviewCheckoutId(activeWorkspace, activeWorkspaceCheckouts);
  const activeTargetType = activeCheckoutId ? "worktree_checkout" : "workspace_home";
  const showInspectorPanel = shouldShowInspectorPanel(activeWorkspace, activeTargetType);
  const activeWorkspaceAllSessions = activeWorkspace
    ? allSessions.filter((session) => session.workspaceId === activeWorkspace.id)
    : [];
  const activeWorkspaceSessions = activeWorkspace
    ? activeWorkspaceAllSessions.filter(
        (session) =>
          !session.closedAt && sessionMatchesTarget(session, activeWorkspace, activeTargetType, activeCheckoutId),
      )
    : [];
  const activeSessionStorageKey = activeWorkspace ? `${activeWorkspace.id}:${activeTargetKey}` : "";
  const activeSessionId = activeWorkspace ? (activeSessionByWorkspace[activeSessionStorageKey] ?? "") : "";
  const activeSession = activeSessionId
    ? (activeWorkspaceSessions.find((session) => session.id === activeSessionId) ?? null)
    : (activeWorkspaceSessions[0] ?? null);
  useEffect(() => {
    if (!showInspectorPanel && mobileView === "inspector") setMobileView("stage");
  }, [showInspectorPanel, mobileView]);

  const [navigatorGrouping, setNavigatorGrouping] = useState(() => readNavigatorGrouping());
  useEffect(() => {
    if (typeof window === "undefined") return;
    const refresh = () => setNavigatorGrouping(readNavigatorGrouping());
    const onStorage = (event: StorageEvent) => {
      if (event.key === "citadel.navigator-group") refresh();
    };
    window.addEventListener("storage", onStorage);
    const unsubscribeGrouping = subscribeToGroupingChanges(refresh);
    const unsubscribeCollapse = subscribeToCollapseChanges(refresh);
    return () => {
      window.removeEventListener("storage", onStorage);
      unsubscribeGrouping();
      unsubscribeCollapse();
    };
  }, []);

  const navTree = useMemo(() => {
    if (!data) return [];
    const levels = treeGroupingFor(navigatorGrouping);
    if (!levels.length) return [];
    return buildGroupTree(
      data.workspaces,
      data.repos,
      data.sessions,
      data.operations,
      levels,
      data.namespaces,
      data.checkouts,
    );
  }, [data, navigatorGrouping]);
  const flatWorkspaceIds = useMemo(() => {
    if (navTree.length) return flattenWorkspaceOrder(navTree);
    return data?.workspaces.map((workspace) => workspace.id) ?? [];
  }, [navTree, data?.workspaces]);

  const [shortcutError, setShortcutError] = useState<string | null>(null);
  const spawnSession = useMutation({
    mutationFn: (input: { workspaceId: string; runtimeId: string; displayName: string }) =>
      api<{ session: WorkspaceSession }>("/api/agent-sessions", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: ({ session }) => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      setActiveSessionByWorkspace((current) => ({
        ...current,
        [`${session.workspaceId}:${targetKeyForSession(session)}`]: session.id,
      }));
      setMobileView("stage");
    },
    onError: (error) => {
      setShortcutError(error instanceof Error ? error.message : "Failed to start session");
    },
  });
  const spawnTerminalSession = useMutation({
    mutationFn: (input: { workspaceId: string; displayName: string }) =>
      api<{ session: WorkspaceSession }>(`/api/workspaces/${input.workspaceId}/terminal-sessions`, {
        method: "POST",
        body: JSON.stringify({ displayName: input.displayName }),
      }),
    onSuccess: ({ session }) => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      setActiveSessionByWorkspace((current) => ({
        ...current,
        [`${session.workspaceId}:${targetKeyForSession(session)}`]: session.id,
      }));
      setMobileView("stage");
    },
    onError: (error) => {
      setShortcutError(error instanceof Error ? error.message : "Failed to start terminal");
    },
  });

  useEffect(() => {
    if (!shortcutError) return;
    const timer = setTimeout(() => setShortcutError(null), 4000);
    return () => clearTimeout(timer);
  }, [shortcutError]);

  const handlerStateRef = useRef({
    flatWorkspaceIds,
    activeWorkspace,
    activeWorkspaceSessions,
    runtimes: data?.agentRuntimes ?? [],
    navTree,
  });
  handlerStateRef.current = {
    flatWorkspaceIds,
    activeWorkspace,
    activeWorkspaceSessions,
    runtimes: data?.agentRuntimes ?? [],
    navTree,
  };

  useEffect(() => {
    const openCreateWorkspace = () => setCreateWorkspaceOpen(true);
    const applyShortcutMatch = (match: ShortcutMatch, preventDefault?: () => void) => {
      const state = handlerStateRef.current;
      const action = resolveShortcutAction(match, state);

      switch (action.type) {
        case "toggle-command-palette":
          preventDefault?.();
          setCommandOpen((open) => !open);
          return;
        case "close-command-palette":
          setCommandOpen(false);
          return;
        case "nav-workspace":
          preventDefault?.();
          if (action.expandGroupPath) expandGroupPath(action.expandGroupPath);
          setActiveWorkspaceId(action.workspaceId);
          setActiveTargetByWorkspace((current) => ({ ...current, [action.workspaceId]: "home" }));
          setMobileView("stage");
          return;
        case "nav-session": {
          preventDefault?.();
          const targetKey = activeTargetByWorkspace[action.workspaceId] ?? "home";
          setActiveSessionByWorkspace((current) => ({
            ...current,
            [`${action.workspaceId}:${targetKey}`]: action.sessionId,
          }));
          setMobileView("stage");
          return;
        }
        case "spawn-terminal":
          preventDefault?.();
          spawnTerminalSession.mutate({ workspaceId: action.workspaceId, displayName: "Terminal" });
          return;
        case "spawn-agent":
          preventDefault?.();
          spawnSession.mutate({
            workspaceId: action.workspaceId,
            runtimeId: action.runtimeId,
            displayName: action.displayName,
          });
          return;
        case "spawn-agent-no-runtime":
          preventDefault?.();
          setShortcutError("No agent runtime available — install Claude Code or another runtime in Settings.");
          return;
        case "noop":
          return;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inEditable =
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT";

      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "n") {
        event.preventDefault();
        openCreateWorkspace();
        return;
      }
      if (
        !inEditable &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "c"
      ) {
        event.preventDefault();
        openCreateWorkspace();
        return;
      }

      const match = matchShortcut(event);
      if (!match) return;
      applyShortcutMatch(match, () => event.preventDefault());
    };
    const onMessage = (event: MessageEvent) => {
      const message = parseRegisteredTerminalShortcutMessage(event, isRegisteredTerminalMessageSource);
      if (!message) return;
      if (message.action === "new-workspace") {
        openCreateWorkspace();
        return;
      }
      const match = terminalShortcutMatch(message);
      if (!match) return;
      applyShortcutMatch(match);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("message", onMessage);
    };
  }, [
    activeTargetByWorkspace,
    setActiveSessionByWorkspace,
    setActiveTargetByWorkspace,
    setActiveWorkspaceId,
    spawnSession,
    spawnTerminalSession,
  ]);

  const focusWorkspaceTarget = (workspaceId: string, targetKey: string) => {
    setActiveWorkspaceId(workspaceId);
    setActiveTargetByWorkspace((current) => ({ ...current, [workspaceId]: targetKey }));
    setMobileView("stage");
    const workspace = data?.workspaces.find((entry) => entry.id === workspaceId);
    const checkouts = allCheckouts.filter((checkout) => checkout.workspaceId === workspaceId && !checkout.archivedAt);
    const checkoutId = checkoutIdFromTargetKey(targetKey, checkouts);
    const targetType = checkoutId ? "worktree_checkout" : "workspace_home";
    const targetSessionId =
      activeSessionByWorkspace[`${workspaceId}:${targetKey}`] ??
      allSessions.find(
        (session) =>
          workspace &&
          session.workspaceId === workspaceId &&
          !session.closedAt &&
          sessionMatchesTarget(session, workspace, targetType, checkoutId),
      )?.id;
    if (targetSessionId) {
      focusTerminalSoon(targetSessionId);
    }
  };
  const focusWorkspace = (workspace: Workspace) => {
    focusWorkspaceTarget(workspace.id, "home");
  };
  const focusWorkspaceId = (workspaceId: string) => {
    focusWorkspaceTarget(workspaceId, "home");
  };

  const repoNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const repo of data?.repos ?? []) map[repo.id] = repo.name;
    return map;
  }, [data?.repos]);

  const workspaceMeta = useMemo(() => {
    const map: Record<string, { readiness?: string; prTone?: string; prNumber?: number | null; attention?: string }> =
      {};
    for (const workspace of data?.workspaces ?? []) {
      const sessions = data?.sessions.filter((session) => session.workspaceId === workspace.id) ?? [];
      const operations = data?.operations.filter((operation) => operation.workspaceId === workspace.id) ?? [];
      const attention = readinessForWorkspace(workspace, { sessions, operations });
      const pr =
        workspace.id === cockpitSummary.data?.workspaceId
          ? (cockpitSummary.data.versionControl.pullRequest ?? null)
          : (prByWorkspaceId.get(workspace.id) ?? null);
      const entry: { readiness?: string; prTone?: string; prNumber?: number | null; attention?: string } = {
        readiness: attention.label,
        attention: attention.tone,
        prNumber: pr?.number ?? null,
      };
      if (pr) entry.prTone = prToneFor(pr);
      map[workspace.id] = entry;
    }
    return map;
  }, [data?.workspaces, data?.sessions, data?.operations, cockpitSummary.data, prByWorkspaceId]);

  if (state.isLoading && !data)
    return (
      <div className="empty" style={{ margin: 16 }}>
        Loading local state
      </div>
    );

  return (
    <div className="cockpit-shell">
      <TopBar
        onSearch={() => setCommandOpen(true)}
        activeWorkspace={activeWorkspace}
        repo={selectedRepo}
        runtimes={data?.agentRuntimes ?? []}
      />
      <GhCooldownBanner summaries={stickySummaries} />
      <RestoreBanner bootRestore={data?.bootRestore ?? null} />
      {shortcutError ? (
        <div className="cockpit-shortcut-error" role="alert" aria-live="polite">
          {shortcutError}
        </div>
      ) : null}
      <div
        className={`cockpit-body ${layout.state.leftCollapsed ? "left-collapsed" : ""} ${
          showInspectorPanel && layout.state.rightCollapsed ? "right-collapsed" : ""
        } ${showInspectorPanel ? "" : "right-hidden"}`}
        style={
          {
            "--col-left": `${layout.state.leftWidth}px`,
            "--col-right": `${layout.state.rightWidth}px`,
          } as React.CSSProperties
        }
      >
        <nav className="mobile-switcher" aria-label="Workspace layout">
          {(showInspectorPanel
            ? (["navigator", "stage", "inspector"] as MobileView[])
            : (["navigator", "stage"] as MobileView[])
          ).map((view) => (
            <button
              key={view}
              type="button"
              className={mobileView === view ? "active" : ""}
              onClick={() => setMobileView(view)}
            >
              {view[0]?.toUpperCase() + view.slice(1)}
            </button>
          ))}
        </nav>
        {layout.state.leftCollapsed ? (
          <CollapsedLeftRail
            workspaces={data?.workspaces ?? []}
            activeWorkspaceId={activeWorkspace?.id ?? ""}
            sessions={data?.sessions ?? []}
            onExpand={layout.toggleLeft}
            onPickWorkspace={focusWorkspace}
          />
        ) : (
          <aside
            className={`column col-left ${mobileView === "navigator" ? "" : "mobile-hidden"}`}
            aria-label="Navigator"
          >
            <Navigator
              repos={data?.repos ?? []}
              workspaces={data?.workspaces ?? []}
              checkouts={allCheckouts}
              sessions={data?.sessions ?? []}
              operations={data?.operations ?? []}
              prByWorkspaceId={prByWorkspaceId}
              checkoutPrByWorkspaceId={checkoutPrByWorkspaceId}
              activeWorkspaceId={activeWorkspace?.id ?? ""}
              activeTargetKey={activeTargetKey}
              runtimes={data?.agentRuntimes ?? []}
              namespaces={data?.namespaces ?? []}
              lastRepoId={lastRepoId || undefined}
              createWorkspaceOpen={createWorkspaceOpen}
              onOpenCreateWorkspace={() => setCreateWorkspaceOpen(true)}
              onCloseCreateWorkspace={() => setCreateWorkspaceOpen(false)}
              onCollapse={layout.toggleLeft}
              onPickWorkspace={focusWorkspace}
              onPickWorkspaceId={focusWorkspaceId}
              onPickTarget={focusWorkspaceTarget}
            />
          </aside>
        )}
        <div
          className="col-divider"
          onMouseDown={startColumnDrag({
            side: "left",
            initial: layout.state.leftWidth,
            onChange: layout.setLeftWidth,
          })}
          aria-hidden
        />
        <main className={`column col-center ${mobileView === "stage" ? "" : "mobile-hidden"}`} aria-label="Agent stage">
          {activeWorkspace ? (
            <Stage
              workspace={activeWorkspace}
              sessions={activeWorkspaceSessions}
              allSessions={activeWorkspaceAllSessions}
              targetKey={activeTargetKey}
              targetType={activeTargetType}
              checkoutId={activeCheckoutId}
              targetLabel={targetLabel(activeTargetType, activeCheckoutId, activeWorkspaceCheckouts)}
              runtimes={data?.agentRuntimes ?? []}
              terminal={data?.terminal ?? { displayName: "Terminal", command: "bash", args: ["-l"] }}
              activeSessionId={activeSessionId}
              onActiveSession={(sessionId) => {
                setActiveSessionByWorkspace((current) => ({ ...current, [activeSessionStorageKey]: sessionId }));
                focusTerminalSoon(sessionId);
              }}
            />
          ) : (
            <EmptyStage hasRepos={Boolean(data?.repos.length)} />
          )}
        </main>
        {showInspectorPanel ? (
          <>
            <div
              className="col-divider"
              onMouseDown={startColumnDrag({
                side: "right",
                initial: layout.state.rightWidth,
                onChange: layout.setRightWidth,
              })}
              aria-hidden
            />
            {layout.state.rightCollapsed ? (
              <div className="collapsed-rail col-right">
                <button
                  type="button"
                  className="collapse-toggle"
                  onClick={layout.toggleRight}
                  aria-label="Expand inspector"
                  title="Expand inspector"
                >
                  <ChevronsLeft size={14} />
                </button>
              </div>
            ) : (
              <aside
                className={`column col-right ${mobileView === "inspector" ? "" : "mobile-hidden"}`}
                aria-label="Inspector"
              >
                {activeWorkspace ? (
                  <Inspector
                    workspace={activeWorkspace}
                    repo={selectedRepo}
                    sessions={activeWorkspaceSessions}
                    summary={cockpitSummary.data}
                    reviewCheckoutId={reviewCheckoutId}
                    onCollapse={layout.toggleRight}
                  />
                ) : (
                  <EmptyInspector onCollapse={layout.toggleRight} />
                )}
              </aside>
            )}
          </>
        ) : null}
      </div>
      <BottomBar activeWorkspace={activeWorkspace} activeSession={activeSession} sessions={activeWorkspaceSessions} />
      {commandOpen ? (
        <CommandPalette
          workspaces={data?.workspaces ?? []}
          repoNames={repoNames}
          workspaceMeta={workspaceMeta}
          onClose={() => setCommandOpen(false)}
          onPickWorkspace={(workspace) => {
            focusWorkspace(workspace);
            setCommandOpen(false);
          }}
          onNavigate={(path) => {
            setCommandOpen(false);
            navigate({ to: path });
          }}
        />
      ) : null}
    </div>
  );
}

function CitadelMark({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <rect width="100" height="100" rx="22" fill="currentColor" />
      <path d="M22 22h6v6h-6zM36 22h6v6h-6zM50 22h6v6h-6zM64 22h6v6h-6z" fill="var(--c-on-dark)" />
      <path d="M70 48a16 16 0 100 14" stroke="var(--c-on-dark)" strokeWidth="6" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function TopBar(props: {
  onSearch: () => void;
  activeWorkspace: Workspace | null;
  repo: import("@citadel/contracts").Repo | null;
  runtimes: import("@citadel/contracts").AgentRuntime[];
}) {
  return (
    <header className="cit-topbar">
      <div className="cit-brand">
        <CitadelMark size={22} />
        <div className="cit-brand-text">
          <div className="cit-brand-name">Citadel</div>
          <div className="cit-brand-org">v0.42</div>
        </div>
      </div>
      <div className="cit-search-wrap">
        <button
          type="button"
          className="cit-search"
          onClick={props.onSearch}
          aria-label="Search workspaces"
          title="Search workspaces, branches, issues, PRs (Cmd+K)"
        >
          <SearchIcon size={14} />
          <span className="cit-search-placeholder">Search workspaces, branches, issues, PRs, recent commands…</span>
          <kbd className="cit-kbd">⌘K</kbd>
        </button>
      </div>
      <div className="cit-top-right">
        <UsageIndicator runtimes={props.runtimes} />
        <ThemeControls />
        <Link className="cit-icon-btn" to="/settings" aria-label="Settings" title="Open settings">
          <SettingsIcon size={15} />
        </Link>
      </div>
    </header>
  );
}

function EmptyStage(props: { hasRepos: boolean }) {
  return (
    <div className="stage-body" style={{ display: "grid", placeItems: "center", textAlign: "center" }}>
      <div>
        <h2 style={{ fontSize: 16, marginBottom: 6 }}>
          {props.hasRepos ? "Pick or create a workspace" : "Register a repository"}
        </h2>
        <p className="command-result-meta">
          {props.hasRepos
            ? "Use the plus button next to Workspaces, or Cmd+K to find one."
            : "Use the folder-plus button next to Workspaces to add your first repository."}
        </p>
      </div>
    </div>
  );
}

function EmptyInspector(props: { onCollapse: () => void }) {
  return (
    <>
      <div className="column-header">
        <button
          type="button"
          className="collapse-toggle"
          onClick={props.onCollapse}
          aria-label="Collapse inspector"
          title="Collapse inspector"
        >
          <ChevronsLeft size={14} />
        </button>
        <strong>Workspace</strong>
      </div>
      <div className="empty compact" style={{ margin: 12 }}>
        Select a workspace to see PR, deploy, and git context.
      </div>
    </>
  );
}

function useLocalStorage(key: string, fallback: string) {
  const [value, setValue] = useState(() => {
    if (typeof window === "undefined") return fallback;
    return window.localStorage.getItem(key) || fallback;
  });
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(key, value);
  }, [key, value]);
  return [value, setValue] as const;
}

function useLocalStorageRecord(key: string) {
  const [value, setValue] = useState<Record<string, string>>(() => {
    if (typeof window === "undefined") return {};
    try {
      return JSON.parse(window.localStorage.getItem(key) || "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  useEffect(() => {
    if (typeof window !== "undefined") window.localStorage.setItem(key, JSON.stringify(value));
  }, [key, value]);
  return [value, setValue] as const;
}
