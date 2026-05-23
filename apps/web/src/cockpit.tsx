import type { Workspace } from "@citadel/contracts";
import { Link, useLocation, useNavigate, useSearch } from "@tanstack/react-router";
import { ChevronsLeft, ChevronsRight, Moon, Search as SearchIcon, Settings as SettingsIcon, Sun } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useEventRefresh, useStateQuery } from "./app-state.js";
import { readinessForWorkspace } from "./cockpit-readiness.js";
import { useWorkspaceCockpitSummary } from "./cockpit-tools.js";
import { CommandPalette } from "./command-palette.js";
import { Inspector } from "./inspector.js";
import { Navigator } from "./navigator.js";
import { Stage } from "./stage.js";
import { startColumnDrag, useCockpitLayout } from "./use-cockpit-layout.js";
import { useResolvedTheme } from "./use-resolved-theme.js";
import { prToneFor } from "./workspace-card.js";

const STORAGE_LAST_WORKSPACE = "citadel.last-workspace";
const STORAGE_LAST_REPO = "citadel.last-repo";
const STORAGE_SESSION_BY_WORKSPACE = "citadel.session-by-workspace";

type MobileView = "navigator" | "stage" | "inspector";

export function Cockpit() {
  const state = useStateQuery();
  useEventRefresh();
  const data = state.data;
  const navigate = useNavigate();
  const search = (useSearch({ strict: false }) ?? {}) as { workspace?: string };
  const location = useLocation();

  const layout = useCockpitLayout();
  const [activeWorkspaceId, setActiveWorkspaceId] = useLocalStorage(STORAGE_LAST_WORKSPACE, "");
  const [lastRepoId, setLastRepoId] = useLocalStorage(STORAGE_LAST_REPO, "");
  const [activeSessionByWorkspace, setActiveSessionByWorkspace] = useLocalStorageRecord(STORAGE_SESSION_BY_WORKSPACE);
  const [commandOpen, setCommandOpen] = useState(false);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [mobileView, setMobileView] = useState<MobileView>("stage");

  // Re-route search-param-driven workspace selection (used from dashboard/history)
  useEffect(() => {
    if (search.workspace) {
      setActiveWorkspaceId(search.workspace);
      navigate({ to: location.pathname, search: {} as Record<string, string> });
    }
  }, [search.workspace, navigate, location.pathname, setActiveWorkspaceId]);

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
    if (activeWorkspace && activeWorkspace.repoId !== lastRepoId) setLastRepoId(activeWorkspace.repoId);
  }, [activeWorkspace, activeWorkspaceId, lastRepoId, setActiveWorkspaceId, setLastRepoId]);

  const cockpitSummary = useWorkspaceCockpitSummary(activeWorkspace);
  const selectedRepo = activeWorkspace
    ? (data?.repos.find((repo) => repo.id === activeWorkspace.repoId) ?? null)
    : (data?.repos[0] ?? null);
  const allSessions = data?.sessions ?? [];
  const activeWorkspaceSessions = activeWorkspace
    ? allSessions.filter((session) => session.workspaceId === activeWorkspace.id)
    : [];
  const activeSessionId = activeWorkspace ? activeSessionByWorkspace[activeWorkspace.id] : "";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const inEditable =
        target?.isContentEditable ||
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT";
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((open) => !open);
      } else if (
        // Ctrl+N opens the new-workspace modal. This works on macOS, where
        // Ctrl+N is unbound by browsers. On Windows/Linux every major browser
        // (Chrome, Edge, Firefox) binds Ctrl+N to "open new browser window"
        // and ignores preventDefault, so the binding is effectively macOS-
        // only. The plain `c` shortcut below remains as the cross-platform
        // fallback. Cmd+N is reserved by browsers everywhere.
        event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "n"
      ) {
        event.preventDefault();
        setCreateWorkspaceOpen(true);
      } else if (
        // GitHub-style: plain `c` ("create") also opens the new-workspace
        // modal. Skipped while editing so it doesn't hijack typing.
        !inEditable &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "c"
      ) {
        event.preventDefault();
        setCreateWorkspaceOpen(true);
      } else if (event.key === "Escape") {
        setCommandOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const focusWorkspace = (workspace: Workspace) => {
    setActiveWorkspaceId(workspace.id);
    setMobileView("stage");
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
          : null;
      const entry: { readiness?: string; prTone?: string; prNumber?: number | null; attention?: string } = {
        readiness: attention.label,
        attention: attention.tone,
        prNumber: pr?.number ?? null,
      };
      if (pr) entry.prTone = prToneFor(pr);
      map[workspace.id] = entry;
    }
    return map;
  }, [data?.workspaces, data?.sessions, data?.operations, cockpitSummary.data]);

  if (state.isLoading && !data)
    return (
      <div className="empty" style={{ margin: 16 }}>
        Loading local state
      </div>
    );

  return (
    <div className="cockpit-shell">
      <TopBar onSearch={() => setCommandOpen(true)} activeWorkspace={activeWorkspace} repo={selectedRepo} />
      <div
        className={`cockpit-body ${layout.state.leftCollapsed ? "left-collapsed" : ""} ${
          layout.state.rightCollapsed ? "right-collapsed" : ""
        }`}
        style={
          {
            "--col-left": `${layout.state.leftWidth}px`,
            "--col-right": `${layout.state.rightWidth}px`,
          } as React.CSSProperties
        }
      >
        <nav className="mobile-switcher" aria-label="Workspace layout">
          {(["navigator", "stage", "inspector"] as MobileView[]).map((view) => (
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
          <div className="collapsed-rail col-left">
            <button
              type="button"
              className="collapse-toggle"
              onClick={layout.toggleLeft}
              aria-label="Expand navigator"
              title="Expand navigator"
            >
              <ChevronsRight size={14} />
            </button>
          </div>
        ) : (
          <aside
            className={`column col-left ${mobileView === "navigator" ? "" : "mobile-hidden"}`}
            aria-label="Navigator"
          >
            <Navigator
              repos={data?.repos ?? []}
              workspaces={data?.workspaces ?? []}
              sessions={data?.sessions ?? []}
              operations={data?.operations ?? []}
              activeSummary={cockpitSummary.data}
              activeWorkspaceId={activeWorkspace?.id ?? ""}
              runtimes={data?.runtimes ?? []}
              lastRepoId={lastRepoId || undefined}
              createWorkspaceOpen={createWorkspaceOpen}
              onOpenCreateWorkspace={() => setCreateWorkspaceOpen(true)}
              onCloseCreateWorkspace={() => setCreateWorkspaceOpen(false)}
              onCollapse={layout.toggleLeft}
              onPickWorkspace={focusWorkspace}
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
              allSessions={allSessions}
              runtimes={data?.runtimes ?? []}
              activeSessionId={activeSessionId}
              onActiveSession={(sessionId) =>
                setActiveSessionByWorkspace((current) => ({ ...current, [activeWorkspace.id]: sessionId }))
              }
            />
          ) : (
            <EmptyStage hasRepos={Boolean(data?.repos.length)} />
          )}
        </main>
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
                onCollapse={layout.toggleRight}
              />
            ) : (
              <EmptyInspector onCollapse={layout.toggleRight} />
            )}
          </aside>
        )}
      </div>
      <BottomBar activeWorkspace={activeWorkspace} repo={selectedRepo} sessions={activeWorkspaceSessions} />
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
}) {
  return (
    <header className="top-bar">
      <div className="top-bar-brand">
        <span className="top-bar-brand-mark" aria-hidden="true">
          <CitadelMark size={14} />
        </span>
        <span className="top-bar-brand-text">
          <span className="top-bar-brand-name">Citadel</span>
          <span className="top-bar-brand-org">{props.repo?.name ?? "local"}</span>
        </span>
      </div>
      <div className="top-bar-search-wrap">
        <button
          type="button"
          className="top-bar-search"
          onClick={props.onSearch}
          aria-label="Search workspaces"
          title="Search workspaces, branches, issues, PRs (Cmd+K)"
        >
          <SearchIcon size={13} />
          <span>Search workspaces, branches, issues, PRs…</span>
          <span className="top-bar-search-shortcut">⌘K</span>
        </button>
      </div>
      <div className="top-bar-actions">
        <ThemeToggle />
        <Link className="top-bar-icon" to="/settings" aria-label="Settings" title="Open settings">
          <SettingsIcon size={14} />
        </Link>
      </div>
    </header>
  );
}

function ThemeToggle() {
  const resolved = useResolvedTheme();
  const isDark = resolved === "dark";
  const toggle = () => {
    const next = isDark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem("citadel.theme", next);
    } catch {
      // localStorage is best-effort
    }
  };
  return (
    <button
      type="button"
      className="top-bar-icon"
      onClick={toggle}
      aria-label="Toggle theme"
      title={isDark ? "Switch to light theme" : "Switch to dark theme"}
    >
      {isDark ? <Sun size={14} /> : <Moon size={14} />}
    </button>
  );
}

function BottomBar(props: {
  activeWorkspace: Workspace | null;
  repo: import("@citadel/contracts").Repo | null;
  sessions: import("@citadel/contracts").AgentSession[];
}) {
  const [now, setNow] = useState(() => formatClock(new Date()));
  useEffect(() => {
    const id = window.setInterval(() => setNow(formatClock(new Date())), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const running = props.sessions.some((s) => s.status === "running");
  const branch = props.activeWorkspace?.branch ?? "";
  const repoName = props.repo?.name ?? "";

  return (
    <footer className="bottom-bar" aria-label="Status bar">
      <div className="bottom-bar-left">
        <span className={`bottom-bar-pill ${running ? "tone-running" : "tone-idle"}`}>
          <span className="bottom-bar-pulse" aria-hidden="true" />
          {running ? "Running" : "Idle"}
        </span>
        {repoName ? (
          <>
            <span className="bottom-bar-divider" aria-hidden="true" />
            <span className="bottom-bar-item bottom-bar-mono">{repoName}</span>
          </>
        ) : null}
        {branch ? (
          <>
            <span className="bottom-bar-divider" aria-hidden="true" />
            <span className="bottom-bar-item bottom-bar-branch">{branch}</span>
          </>
        ) : null}
      </div>
      <div className="bottom-bar-right">
        <span className="bottom-bar-item bottom-bar-muted">{now}</span>
      </div>
    </footer>
  );
}

function formatClock(d: Date) {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
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
