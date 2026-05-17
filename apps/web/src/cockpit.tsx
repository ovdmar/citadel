import type { ActivityEvent, AgentRuntime, AgentSession, ProviderHealth, Repo, Workspace } from "@citadel/contracts";
import {
  Activity,
  Blocks,
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
  TerminalSquare,
} from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityRow } from "./activity-row.js";
import { useEventRefresh, useStateQuery } from "./app-state.js";
import { DiffPanel, ProviderSummary, RepoForm, RuntimeLauncher, TerminalPane, WorkspaceForm } from "./cockpit-tools.js";
import { Button } from "./components/ui/button.js";
import { formatLabel } from "./labels.js";

type StageMode = "terminal" | "diff" | "review" | "goal" | "plan";
type MobileView = "navigator" | "stage" | "inspector";

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
      if (!editable && event.key.toLowerCase() === "g") setStageMode("goal");
      if (!editable && event.key.toLowerCase() === "t") setStageMode("terminal");
      if (!editable && event.key.toLowerCase() === "d") setStageMode("diff");
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
          <HealthStrip providerHealth={data?.providerHealth ?? []} mcpEnabled={Boolean(data?.mcp.enabled)} />
        </div>
      </header>

      <nav className="mobile-switcher" aria-label="Workspace layout">
        {(["navigator", "stage", "inspector"] as MobileView[]).map((view) => (
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
            workspaces={data.workspaces}
            sessions={data.sessions}
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
            activity={data?.activity ?? []}
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
        <span>{data?.operations.length ?? 0} queued/running operations</span>
        <span>{data?.activity[0]?.message ?? "No recent activity"}</span>
        <span>MCP {data?.mcp.enabled ? "enabled" : "disabled"}</span>
      </footer>

      {commandOpen ? (
        <CommandPalette
          workspaces={data?.workspaces ?? []}
          sessions={data?.sessions ?? []}
          onClose={() => setCommandOpen(false)}
          onSelect={(workspace) => {
            focusWorkspace(workspace);
            setCommandOpen(false);
          }}
          onMode={(mode) => {
            setStageMode(mode);
            setCommandOpen(false);
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
  workspaces: Workspace[];
  sessions: AgentSession[];
  activeWorkspaceId: string;
  query: string;
  onSelect: (workspace: Workspace) => void;
}) {
  const filtered = props.workspaces.filter((workspace) => {
    const value =
      `${workspace.name} ${workspace.branch} ${workspace.issueKey ?? ""} ${workspace.issueTitle ?? ""}`.toLowerCase();
    return value.includes(props.query.toLowerCase());
  });
  const groups = ["in-progress", "blocked", "backlog", "done"].map((section) => ({
    section,
    workspaces: filtered.filter((workspace) => bucketForWorkspace(workspace) === section),
  }));
  return (
    <div className="workspace-groups">
      {groups.map((group) =>
        group.workspaces.length ? (
          <section key={group.section} className="workspace-group">
            <h2>{formatLabel(group.section)}</h2>
            {group.workspaces.map((workspace) => (
              <WorkspaceNavRow
                key={workspace.id}
                workspace={workspace}
                sessions={props.sessions.filter((session) => session.workspaceId === workspace.id)}
                active={workspace.id === props.activeWorkspaceId}
                onSelect={() => props.onSelect(workspace)}
              />
            ))}
          </section>
        ) : null,
      )}
      {!filtered.length ? <div className="empty compact">No matching workspaces</div> : null}
    </div>
  );
}

function WorkspaceNavRow(props: {
  workspace: Workspace;
  sessions: AgentSession[];
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button type="button" className={`workspace-nav-row ${props.active ? "active" : ""}`} onClick={props.onSelect}>
      <span className={`status-dot ${statusTone(props.workspace)}`} />
      <span className="workspace-row-main">
        <strong>{props.workspace.name}</strong>
        <small>{props.workspace.branch}</small>
      </span>
      <span className="workspace-row-badges">
        {props.workspace.pinned ? <em>Pin</em> : null}
        {props.workspace.issueKey ? <em>{props.workspace.issueKey}</em> : null}
        {props.workspace.prUrl ? <em>PR</em> : null}
        {props.workspace.dirty ? <em>Dirty</em> : null}
        <em>{props.sessions.length} sessions</em>
      </span>
    </button>
  );
}

function StageToolbar(props: {
  workspace: Workspace;
  sessions: AgentSession[];
  activeSession: AgentSession | null;
  stageMode: StageMode;
  onMode: (mode: StageMode) => void;
  onSession: (sessionId: string) => void;
}) {
  return (
    <div className="stage-toolbar">
      <div className="workspace-identity">
        <GitBranch size={16} />
        <span>{props.workspace.branch}</span>
        <strong>{formatLabel(props.workspace.lifecycle)}</strong>
      </div>
      <div className="stage-tabs" role="tablist" aria-label="Agent stage modes">
        {(["terminal", "diff", "review", "goal", "plan"] as StageMode[]).map((mode) => (
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
              {session.displayName}
            </option>
          ))
        ) : (
          <option value="">No sessions</option>
        )}
      </select>
    </div>
  );
}

function StageBody(props: {
  workspace: Workspace;
  sessions: AgentSession[];
  activeSession: AgentSession | null;
  stageMode: StageMode;
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
  if (props.stageMode === "review") {
    return (
      <StagePlaceholder
        icon={<Blocks />}
        title="Review workspace"
        body="Stacked PR review lanes can attach here in v3."
      />
    );
  }
  if (props.stageMode === "goal") {
    return (
      <StagePlaceholder
        icon={<Command />}
        title={props.workspace.issueTitle || props.workspace.issueKey || "Workspace goal"}
        body="Managed goals and transcript intelligence will attach to this primary workspace context."
      />
    );
  }
  return (
    <StagePlaceholder
      icon={<Activity />}
      title="Plan"
      body="Agent plan and next-step state stays centered on the active workspace."
    />
  );
}

function WorkspaceInspector(props: {
  repo: Repo | null;
  workspace: Workspace;
  sessions: AgentSession[];
  runtimes: AgentRuntime[];
  providerHealth: ProviderHealth[];
  activity: ActivityEvent[];
}) {
  const workspaceActivity = props.activity.filter((event) => event.workspaceId === props.workspace.id).slice(0, 8);
  return (
    <div className="inspector-stack">
      <section className="inspector-section">
        <h2>Next action</h2>
        <p>{nextAction(props.workspace, props.sessions)}</p>
        <div className="inspector-actions">
          <RuntimeLauncher workspace={props.workspace} runtimes={props.runtimes} />
        </div>
      </section>
      {props.repo ? (
        <section className="inspector-section">
          <h2>Provider context</h2>
          <ProviderSummary repo={props.repo} workspace={props.workspace} providerHealth={props.providerHealth} />
        </section>
      ) : null}
      <section className="inspector-section">
        <h2>Workspace state</h2>
        <KeyValue label="Path" value={props.workspace.path} />
        <KeyValue label="Base" value={props.workspace.baseBranch} />
        <KeyValue label="Source" value={formatLabel(props.workspace.source)} />
        <KeyValue label="Sessions" value={String(props.sessions.length)} />
      </section>
      <section className="inspector-section">
        <h2>Activity</h2>
        {workspaceActivity.length ? (
          workspaceActivity.map((event) => <ActivityRow key={event.id} event={event} />)
        ) : (
          <div className="empty compact">No workspace activity yet</div>
        )}
      </section>
      <section className="inspector-section muted">
        <h2>V3 placeholders</h2>
        <p>
          Stacked PRs, transcript intelligence, managed goals, notifications, and MCP control have reserved inspector
          slots.
        </p>
      </section>
    </div>
  );
}

function InspectorHeader(props: { onCollapse: () => void }) {
  return (
    <div className="inspector-header">
      <HeartPulse size={16} />
      <strong>Inspector</strong>
      <Button type="button" variant="ghost" size="icon" onClick={props.onCollapse} aria-label="Collapse inspector">
        <PanelRightClose size={16} />
      </Button>
    </div>
  );
}

function CommandPalette(props: {
  workspaces: Workspace[];
  sessions: AgentSession[];
  onClose: () => void;
  onSelect: (workspace: Workspace) => void;
  onMode: (mode: StageMode) => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const matches = props.workspaces
    .filter((workspace) =>
      `${workspace.name} ${workspace.branch} ${workspace.issueKey ?? ""}`.toLowerCase().includes(query.toLowerCase()),
    )
    .slice(0, 8);
  return (
    <div className="command-backdrop" onMouseDown={props.onClose}>
      <dialog className="command-palette" aria-label="Quick open" open onMouseDown={(event) => event.stopPropagation()}>
        <label className="quick-search command-search">
          <Command size={16} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Switch workspace or run command"
          />
        </label>
        <div className="command-list">
          {matches.map((workspace) => (
            <button key={workspace.id} type="button" onClick={() => props.onSelect(workspace)}>
              <strong>{workspace.name}</strong>
              <span>{workspace.branch}</span>
              <em>{props.sessions.filter((session) => session.workspaceId === workspace.id).length} sessions</em>
            </button>
          ))}
          {(["terminal", "diff", "review", "goal", "plan"] as StageMode[]).map((mode) => (
            <button key={mode} type="button" onClick={() => props.onMode(mode)}>
              <strong>Open {formatLabel(mode)}</strong>
              <span>Stage focus</span>
            </button>
          ))}
        </div>
      </dialog>
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

function bucketForWorkspace(workspace: Workspace) {
  if (workspace.lifecycle === "failed" || workspace.dirty) return "blocked";
  if (workspace.lifecycle === "archived" || workspace.lifecycle === "removed") return "done";
  if (workspace.lifecycle === "ready" || workspace.lifecycle === "creating") return "in-progress";
  return workspace.section || "backlog";
}

function statusTone(workspace: Workspace) {
  if (workspace.lifecycle === "failed" || workspace.dirty) return "warn";
  if (workspace.lifecycle === "ready") return "ready";
  return "neutral";
}

function nextAction(workspace: Workspace, sessions: AgentSession[]) {
  if (workspace.lifecycle === "creating") return "Workspace is being created. Watch the operation status bar.";
  if (workspace.lifecycle === "failed") return "Inspect setup output and provider warnings before retrying.";
  if (!sessions.length) return "Start an agent or shell runtime to begin work in this workspace.";
  if (workspace.dirty) return "Review the diff, run checks, then prepare the PR or archive safely.";
  return "Continue from the active terminal session or open the diff for the next review pass.";
}
