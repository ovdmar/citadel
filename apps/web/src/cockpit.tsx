import type {
  ActivityEvent,
  AgentRuntime,
  AgentSession,
  Operation,
  ProviderHealth,
  Repo,
  Workspace,
  WorkspaceCockpitSummary,
} from "@citadel/contracts";
import { Link } from "@tanstack/react-router";
import {
  Activity,
  Boxes,
  Cable,
  ChevronsLeft,
  ChevronsRight,
  Command,
  GitBranch,
  HeartPulse,
  PanelLeftClose,
  PanelRightClose,
  Plus,
  Search,
  Settings,
  TerminalSquare,
} from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { ActivityRow } from "./activity-row.js";
import { useEventRefresh, useStateQuery } from "./app-state.js";
import { type WorkspaceAttention, nextAction, readinessForWorkspace } from "./cockpit-readiness.js";
import {
  CommandPalette,
  MobileMonitor,
  ReconcileButton,
  SessionStopButton,
  type StageMode as ShellStageMode,
} from "./cockpit-shell.js";
import {
  AppsActionsPanel,
  DiffPanel,
  HookDiagnosticsPanel,
  RepoForm,
  RuntimeLauncher,
  TerminalPane,
  WorkspaceCockpitPanel,
  WorkspaceForm,
  useWorkspaceCockpitSummary,
} from "./cockpit-tools.js";
import { Button } from "./components/ui/button.js";
import { formatLabel } from "./labels.js";

type StageMode = ShellStageMode;
type MobileView = "monitor" | "navigator" | "stage" | "inspector";

export function Cockpit() {
  const state = useStateQuery();
  useEventRefresh();
  const data = state.data;
  const [query, setQuery] = useState("");
  const [activeWorkspaceId, setActiveWorkspaceId] = useLocalStorage("citadel.activeWorkspaceId", "");
  const [activeSessionByWorkspace, setActiveSessionByWorkspace] = useLocalStorageRecord("citadel.activeSessions");
  const [stageMode, setStageMode] = useState<StageMode>("terminal");
  const [mobileView, setMobileView] = useState<MobileView>("stage");
  const [navigatorOpen, setNavigatorOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [commandOpen, setCommandOpen] = useState(false);

  const activeWorkspace = useMemo(() => {
    if (!data?.workspaces.length) return null;
    return (
      data.workspaces.find((workspace) => workspace.id === activeWorkspaceId) ??
      [...data.workspaces].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ??
      null
    );
  }, [activeWorkspaceId, data?.workspaces]);
  const selectedRepo = activeWorkspace
    ? data?.repos.find((repo) => repo.id === activeWorkspace.repoId)
    : data?.repos[0];
  const activeWorkspaceSessions = activeWorkspace
    ? (data?.sessions.filter((session) => session.workspaceId === activeWorkspace.id) ?? [])
    : [];
  const cockpitSummary = useWorkspaceCockpitSummary(activeWorkspace);
  const activeSessionId = activeWorkspace ? activeSessionByWorkspace[activeWorkspace.id] : "";
  const activeSession =
    activeWorkspaceSessions.find((session) => session.id === activeSessionId) ?? activeWorkspaceSessions[0] ?? null;

  useEffect(() => {
    if (activeWorkspace && activeWorkspace.id !== activeWorkspaceId) setActiveWorkspaceId(activeWorkspace.id);
  }, [activeWorkspace, activeWorkspaceId, setActiveWorkspaceId]);

  useEffect(() => {
    if (!activeWorkspace || !activeSession || activeSessionByWorkspace[activeWorkspace.id] === activeSession.id) return;
    setActiveSessionByWorkspace((current) => ({ ...current, [activeWorkspace.id]: activeSession.id }));
  }, [activeSession, activeSessionByWorkspace, activeWorkspace, setActiveSessionByWorkspace]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editable = target?.matches("input, textarea, select, [contenteditable='true']");
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen((open) => !open);
      }
      if (!editable && event.key.toLowerCase() === "t") setStageMode("terminal");
      if (!editable && event.key.toLowerCase() === "d") setStageMode("diff");
      if (!editable && event.key.toLowerCase() === "r") setStageMode("review");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const focusWorkspace = (workspace: Workspace) => {
    setActiveWorkspaceId(workspace.id);
    setMobileView("stage");
  };

  if (state.isLoading) return <div className="ade-loading">Loading local state</div>;

  return (
    <div
      className={`ade-shell ${navigatorOpen ? "" : "navigator-collapsed"} ${inspectorOpen ? "" : "inspector-collapsed"}`}
    >
      <header className="ade-topbar">
        <div>
          <span className="eyebrow">Agent Development Environment</span>
          <h1>{activeWorkspace ? activeWorkspace.name : "Create or import a workspace"}</h1>
        </div>
        <div className="ade-topbar-actions">
          <Button type="button" variant="secondary" onClick={() => setCommandOpen(true)}>
            <Command size={15} /> Quick open
          </Button>
          <Link className="settings-link icon" to="/settings" aria-label="Settings">
            <Settings size={15} />
            Settings
          </Link>
          <HealthStrip providerHealth={data?.providerHealth ?? []} mcpEnabled={Boolean(data?.mcp.enabled)} />
        </div>
      </header>

      <nav className="mobile-switcher" aria-label="Workspace layout">
        {(["monitor", "navigator", "stage", "inspector"] as MobileView[]).map((view) => (
          <button
            key={view}
            type="button"
            className={mobileView === view ? "active" : ""}
            onClick={() => setMobileView(view)}
          >
            {formatLabel(view)}
          </button>
        ))}
      </nav>

      <aside
        className={`mobile-monitor mobile-${mobileView === "monitor" ? "active" : "hidden"}`}
        aria-label="Mobile monitor"
      >
        <MobileMonitor
          workspaces={data?.workspaces ?? []}
          sessions={data?.sessions ?? []}
          operations={data?.operations ?? []}
          providerHealth={data?.providerHealth ?? []}
          activity={data?.activity ?? []}
        />
      </aside>

      <aside className={`workspace-navigator mobile-${mobileView === "navigator" ? "active" : "hidden"}`}>
        <NavigatorHeader
          repos={data?.repos ?? []}
          workspaces={data?.workspaces ?? []}
          query={query}
          onQuery={setQuery}
          onCollapse={() => setNavigatorOpen(false)}
        />
        {data?.workspaces.length ? (
          <WorkspaceNavigator
            repos={data.repos}
            workspaces={data.workspaces}
            sessions={data.sessions}
            operations={data.operations}
            activeSummary={cockpitSummary.data}
            activeWorkspaceId={activeWorkspace?.id ?? ""}
            query={query}
            onSelect={focusWorkspace}
          />
        ) : (
          <CreateWorkspaceStart repo={selectedRepo ?? null} />
        )}
      </aside>

      {!navigatorOpen ? (
        <Button
          className="edge-toggle left"
          type="button"
          variant="secondary"
          size="icon"
          onClick={() => setNavigatorOpen(true)}
        >
          <ChevronsRight size={16} />
        </Button>
      ) : null}

      <main className={`agent-stage mobile-${mobileView === "stage" ? "active" : "hidden"}`}>
        {activeWorkspace ? (
          <>
            <StageToolbar
              workspace={activeWorkspace}
              sessions={activeWorkspaceSessions}
              activeSession={activeSession}
              summary={cockpitSummary.data}
              stageMode={stageMode}
              onMode={setStageMode}
              onSession={(sessionId) =>
                setActiveSessionByWorkspace((current) => ({ ...current, [activeWorkspace.id]: sessionId }))
              }
            />
            <StageBody
              workspace={activeWorkspace}
              sessions={data?.sessions ?? []}
              activeSession={activeSession}
              stageMode={stageMode}
              summary={cockpitSummary.data}
              summaryLoading={cockpitSummary.isLoading}
            />
          </>
        ) : (
          <EmptyWorkspaceFlow repo={selectedRepo ?? null} />
        )}
      </main>

      <aside className={`workspace-inspector mobile-${mobileView === "inspector" ? "active" : "hidden"}`}>
        <InspectorHeader onCollapse={() => setInspectorOpen(false)} />
        {activeWorkspace ? (
          <WorkspaceInspector
            repo={selectedRepo ?? null}
            workspace={activeWorkspace}
            sessions={activeWorkspaceSessions}
            runtimes={data?.runtimes ?? []}
            providerHealth={data?.providerHealth ?? []}
            operations={data?.operations ?? []}
            activity={data?.activity ?? []}
            summary={cockpitSummary.data}
            summaryLoading={cockpitSummary.isLoading}
          />
        ) : (
          <CreateWorkspaceStart repo={selectedRepo ?? null} compact />
        )}
      </aside>

      {!inspectorOpen ? (
        <Button
          className="edge-toggle right"
          type="button"
          variant="secondary"
          size="icon"
          onClick={() => setInspectorOpen(true)}
        >
          <ChevronsLeft size={16} />
        </Button>
      ) : null}

      <footer className="operations-bar">
        <Link to="/operations" className="settings-link compact">
          {data?.operations.length ?? 0} operations
        </Link>
        <span>{data?.activity[0]?.message ?? "No recent activity"}</span>
        <span>MCP {data?.mcp.enabled ? "enabled" : "disabled"}</span>
      </footer>

      {commandOpen ? (
        <CommandPalette
          workspaces={data?.workspaces ?? []}
          sessions={data?.sessions ?? []}
          activeWorkspace={activeWorkspace}
          activeSession={activeSession}
          onClose={() => setCommandOpen(false)}
          onSelect={(workspace) => {
            focusWorkspace(workspace);
            setCommandOpen(false);
          }}
          onMode={(mode) => {
            setStageMode(mode);
            setCommandOpen(false);
          }}
          onNavigate={(path) => {
            window.location.assign(path);
          }}
        />
      ) : null}
    </div>
  );
}

function NavigatorHeader(props: {
  repos: Repo[];
  workspaces: Workspace[];
  query: string;
  onQuery: (query: string) => void;
  onCollapse: () => void;
}) {
  return (
    <div className="navigator-header">
      <div className="navigator-title">
        <Boxes size={16} />
        <strong>Workspaces</strong>
        <Button type="button" variant="ghost" size="icon" onClick={props.onCollapse} aria-label="Collapse navigator">
          <PanelLeftClose size={16} />
        </Button>
      </div>
      <label className="quick-search">
        <Search size={15} />
        <input
          value={props.query}
          onChange={(event) => props.onQuery(event.target.value)}
          placeholder="Search workspace, branch, issue"
        />
      </label>
      <div className="navigator-counts">
        <span>{props.repos.length} repos</span>
        <span>{props.workspaces.length} workspaces</span>
      </div>
    </div>
  );
}

function WorkspaceNavigator(props: {
  repos: Repo[];
  workspaces: Workspace[];
  sessions: AgentSession[];
  operations: Operation[];
  activeSummary: WorkspaceCockpitSummary | undefined;
  activeWorkspaceId: string;
  query: string;
  onSelect: (workspace: Workspace) => void;
}) {
  const filtered = props.workspaces.filter((workspace) => {
    const value =
      `${workspace.name} ${workspace.branch} ${workspace.issueKey ?? ""} ${workspace.issueTitle ?? ""}`.toLowerCase();
    return value.includes(props.query.toLowerCase());
  });
  const repoGroups = props.repos
    .map((repo) => ({
      repo,
      workspaces: filtered.filter((workspace) => workspace.repoId === repo.id),
    }))
    .filter((group) => group.workspaces.length);
  return (
    <div className="workspace-groups">
      {repoGroups.map((repoGroup) => (
        <section key={repoGroup.repo.id} className="workspace-repo-group">
          <h2>{repoGroup.repo.name}</h2>
          {["blocked", "needs-review", "working", "dirty", "idle", "done"].map((section) => {
            const sectionWorkspaces = repoGroup.workspaces.filter(
              (workspace) =>
                readinessForWorkspace(workspace, {
                  sessions: props.sessions.filter((session) => session.workspaceId === workspace.id),
                  operations: props.operations.filter((operation) => operation.workspaceId === workspace.id),
                  summary: workspace.id === props.activeSummary?.workspaceId ? props.activeSummary : undefined,
                }).section === section,
            );
            return sectionWorkspaces.length ? (
              <div key={section} className="workspace-group">
                <h3>{formatLabel(section)}</h3>
                {sectionWorkspaces.map((workspace) => {
                  const attention = readinessForWorkspace(workspace, {
                    sessions: props.sessions.filter((session) => session.workspaceId === workspace.id),
                    operations: props.operations.filter((operation) => operation.workspaceId === workspace.id),
                    summary: workspace.id === props.activeSummary?.workspaceId ? props.activeSummary : undefined,
                  });
                  return (
                    <WorkspaceNavRow
                      key={workspace.id}
                      workspace={workspace}
                      sessions={props.sessions.filter((session) => session.workspaceId === workspace.id)}
                      attention={attention}
                      active={workspace.id === props.activeWorkspaceId}
                      onSelect={() => props.onSelect(workspace)}
                    />
                  );
                })}
              </div>
            ) : null;
          })}
        </section>
      ))}
      {!filtered.length ? <div className="empty compact">No matching workspaces</div> : null}
    </div>
  );
}

function WorkspaceNavRow(props: {
  workspace: Workspace;
  sessions: AgentSession[];
  attention: WorkspaceAttention;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={`workspace-nav-row ${props.active ? "active" : ""}`} onClick={props.onSelect}>
      <span className={`status-dot ${props.attention.tone}`} />
      <span className="workspace-row-main">
        <strong>{props.workspace.name}</strong>
        <small>
          {props.attention.label} - {props.attention.nextAction}
        </small>
      </span>
      <span className="workspace-row-badges">
        {props.workspace.pinned ? <em>Pin</em> : null}
        {props.workspace.issueKey ? <em>{props.workspace.issueKey}</em> : null}
        {props.workspace.prUrl ? <em>PR</em> : null}
        {props.workspace.dirty ? <em>Dirty</em> : null}
        <em>{props.sessions.filter((session) => ["running", "waiting"].includes(session.status)).length} active</em>
      </span>
    </button>
  );
}

function StageToolbar(props: {
  workspace: Workspace;
  sessions: AgentSession[];
  activeSession: AgentSession | null;
  summary: WorkspaceCockpitSummary | undefined;
  stageMode: StageMode;
  onMode: (mode: StageMode) => void;
  onSession: (sessionId: string) => void;
}) {
  const readiness = props.summary?.readiness;
  return (
    <div className="stage-header">
      <div className="stage-toolbar">
        <div className="workspace-identity">
          <GitBranch size={16} />
          <span>{props.workspace.branch}</span>
          <strong>{readiness ? formatLabel(readiness.state) : formatLabel(props.workspace.lifecycle)}</strong>
        </div>
        <div className="stage-tabs" role="tablist" aria-label="Agent stage modes">
          {(["terminal", "diff", "review"] as StageMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={props.stageMode === mode ? "active" : ""}
              onClick={() => props.onMode(mode)}
            >
              {formatLabel(mode)}
            </button>
          ))}
        </div>
        <select
          className="session-select"
          value={props.activeSession?.id ?? ""}
          onChange={(event) => props.onSession(event.target.value)}
          aria-label="Active session"
        >
          {props.sessions.length ? (
            props.sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.displayName} - {formatLabel(session.status)}
              </option>
            ))
          ) : (
            <option value="">No sessions</option>
          )}
        </select>
        <SessionStopButton session={props.activeSession} />
      </div>
      <ReadinessStrip workspace={props.workspace} sessions={props.sessions} summary={props.summary} />
    </div>
  );
}

function StageBody(props: {
  workspace: Workspace;
  sessions: AgentSession[];
  activeSession: AgentSession | null;
  stageMode: StageMode;
  summary: WorkspaceCockpitSummary | undefined;
  summaryLoading: boolean | undefined;
}) {
  if (props.stageMode === "terminal") {
    const workspaceSessions = props.sessions.filter((session) => session.workspaceId === props.workspace.id);
    return (
      <div className="terminal-stage" data-testid="terminal-stage">
        {workspaceSessions.length ? (
          workspaceSessions.map((session) => (
            <div
              key={session.id}
              className={session.id === props.activeSession?.id ? "terminal-active" : "terminal-hidden"}
            >
              <TerminalPane session={session} />
            </div>
          ))
        ) : (
          <StagePlaceholder
            icon={<TerminalSquare />}
            title="No terminal session"
            body="Start a runtime from the inspector."
          />
        )}
      </div>
    );
  }
  if (props.stageMode === "diff") return <DiffPanel workspace={props.workspace} />;
  return <WorkspaceCockpitPanel summary={props.summary} loading={props.summaryLoading} />;
}

function WorkspaceInspector(props: {
  repo: Repo | null;
  workspace: Workspace;
  sessions: AgentSession[];
  runtimes: AgentRuntime[];
  providerHealth: ProviderHealth[];
  operations: Operation[];
  activity: ActivityEvent[];
  summary: WorkspaceCockpitSummary | undefined;
  summaryLoading: boolean | undefined;
}) {
  const workspaceActivity = props.activity.filter((event) => event.workspaceId === props.workspace.id).slice(0, 8);
  const failedOperation = props.operations.find(
    (operation) => operation.workspaceId === props.workspace.id && operation.status === "failed",
  );
  return (
    <div className="inspector-stack">
      <section className="inspector-section">
        <h2>Next action</h2>
        <p>{props.summary?.readiness.nextAction ?? nextAction(props.workspace, props.sessions)}</p>
        {props.summary?.readiness.reasons.length ? (
          <ul className="reason-list">
            {props.summary.readiness.reasons.slice(0, 4).map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
        <div className="inspector-actions">
          <RuntimeLauncher workspace={props.workspace} runtimes={props.runtimes} />
        </div>
      </section>
      {failedOperation ? (
        <section className="inspector-section danger">
          <h2>Failed operation</h2>
          <p>{failedOperation.error || failedOperation.message || failedOperation.type}</p>
        </section>
      ) : null}
      {props.repo ? (
        <section className="inspector-section">
          <h2>Applications</h2>
          <AppsActionsPanel apps={props.summary?.apps} />
        </section>
      ) : null}
      {props.repo ? (
        <section className="inspector-section">
          <h2>Hook diagnostics</h2>
          <HookDiagnosticsPanel repo={props.repo} workspace={props.workspace} />
        </section>
      ) : null}
      <section className="inspector-section">
        <h2>Workspace state</h2>
        <KeyValue label="Path" value={props.workspace.path} />
        <KeyValue label="Base" value={props.workspace.baseBranch} />
        <KeyValue label="Source" value={formatLabel(props.workspace.source)} />
        <KeyValue label="Sessions" value={String(props.sessions.length)} />
        <KeyValue
          label="Providers"
          value={`${props.providerHealth.filter((provider) => provider.status === "healthy").length}/${props.providerHealth.length}`}
        />
      </section>
      <section className="inspector-section">
        <h2>Activity</h2>
        {workspaceActivity.length ? (
          workspaceActivity.map((event) => <ActivityRow key={event.id} event={event} />)
        ) : (
          <div className="empty compact">No workspace activity yet</div>
        )}
      </section>
    </div>
  );
}

function InspectorHeader(props: { onCollapse: () => void }) {
  return (
    <div className="inspector-header">
      <HeartPulse size={16} />
      <strong>Inspector</strong>
      <ReconcileButton />
      <Button type="button" variant="ghost" size="icon" onClick={props.onCollapse} aria-label="Collapse inspector">
        <PanelRightClose size={16} />
      </Button>
    </div>
  );
}

function HealthStrip(props: { providerHealth: ProviderHealth[]; mcpEnabled: boolean }) {
  const blockers = props.providerHealth.filter((provider) => provider.status !== "healthy");
  return (
    <div className={`health-strip ${blockers.length ? "warn" : "ok"}`}>
      <Cable size={15} />
      <span>{blockers.length ? `${blockers.length} provider warnings` : "Providers ready"}</span>
      <span>MCP {props.mcpEnabled ? "on" : "off"}</span>
    </div>
  );
}

function CreateWorkspaceStart(props: { repo: Repo | null; compact?: boolean }) {
  return (
    <div className={props.compact ? "create-start compact" : "create-start"}>
      <RepoForm />
      {props.repo ? (
        <WorkspaceForm repo={props.repo} />
      ) : (
        <div className="empty compact">Register a repo before creating workspaces</div>
      )}
    </div>
  );
}

function EmptyWorkspaceFlow(props: { repo: Repo | null }) {
  return (
    <div className="empty-workspace-flow">
      <Plus size={24} />
      <h2>Start with a workspace</h2>
      <CreateWorkspaceStart repo={props.repo} />
    </div>
  );
}

function StagePlaceholder(props: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="stage-placeholder">
      {props.icon}
      <h2>{props.title}</h2>
      <p>{props.body}</p>
    </div>
  );
}

function Empty(props: { text: string }) {
  return <div className="empty">{props.text}</div>;
}

function KeyValue(props: { label: string; value: string }) {
  return (
    <div className="key-value">
      <span>{props.label}</span>
      <strong>{props.value}</strong>
    </div>
  );
}

function ReadinessStrip(props: {
  workspace: Workspace;
  sessions: AgentSession[];
  summary: WorkspaceCockpitSummary | undefined;
}) {
  const attention = readinessForWorkspace(props.workspace, {
    sessions: props.sessions,
    operations: [],
    summary: props.summary,
  });
  const reasons = props.summary?.readiness.reasons ?? [];
  return (
    <div className={`readiness-strip ${attention.tone}`}>
      <div>
        <strong>{attention.label}</strong>
        <span>{attention.nextAction}</span>
      </div>
      <div className="readiness-metrics">
        {props.summary ? (
          <>
            <span>{props.summary.git.clean ? "clean" : "dirty"}</span>
            <span>
              {props.summary.versionControl.pullRequest
                ? `PR #${props.summary.versionControl.pullRequest.number}`
                : "no PR"}
            </span>
            <span>{props.summary.apps.actions.length} actions</span>
          </>
        ) : (
          <span>{props.sessions.length} sessions</span>
        )}
      </div>
      {reasons.length ? <small>{reasons.slice(0, 2).join(" | ")}</small> : null}
    </div>
  );
}

function useLocalStorage(key: string, fallback: string) {
  const [value, setValue] = useState(() => localStorage.getItem(key) || fallback);
  useEffect(() => localStorage.setItem(key, value), [key, value]);
  return [value, setValue] as const;
}

function useLocalStorageRecord(key: string) {
  const [value, setValue] = useState<Record<string, string>>(() => {
    try {
      return JSON.parse(localStorage.getItem(key) || "{}") as Record<string, string>;
    } catch {
      return {};
    }
  });
  useEffect(() => localStorage.setItem(key, JSON.stringify(value)), [key, value]);
  return [value, setValue] as const;
}
