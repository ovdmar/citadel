import type { AgentSession, Operation, Repo, Workspace, WorkspaceCockpitSummary } from "@citadel/contracts";
import { Link, useLocation } from "@tanstack/react-router";
import {
  AlarmClock,
  ChevronRight,
  ClipboardList,
  FolderPlus,
  LayoutDashboard,
  NotebookPen,
  PanelLeftClose,
  Plus,
  Settings2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AddRepoModal, CreateWorkspaceModal, GroupByOverlay, type GroupKey } from "./modals.js";
import { type GroupNode, type WorkspaceEntry, buildGroupTree, collectGroupPaths } from "./navigator-groups.js";
import { WorkspaceCard } from "./workspace-card.js";

const GROUP_STORAGE = "citadel.navigator-group";
const COLLAPSE_STORAGE = "citadel.navigator-group-collapsed";

export function Navigator(props: {
  repos: Repo[];
  workspaces: Workspace[];
  sessions: AgentSession[];
  operations: Operation[];
  activeSummary: WorkspaceCockpitSummary | undefined;
  activeWorkspaceId: string;
  runtimes: import("@citadel/contracts").AgentRuntime[];
  lastRepoId: string | undefined;
  createWorkspaceOpen: boolean;
  onOpenCreateWorkspace: () => void;
  onCloseCreateWorkspace: () => void;
  onCollapse: () => void;
  onPickWorkspace: (workspace: Workspace) => void;
}) {
  const location = useLocation();
  const path = location.pathname;
  const [grouping, setGrouping] = useState<GroupKey[]>(() => {
    if (typeof window === "undefined") return ["repo", "status"];
    try {
      const raw = window.localStorage.getItem(GROUP_STORAGE);
      if (!raw) return ["repo", "status"];
      const parsed = JSON.parse(raw) as GroupKey[];
      const allowed = parsed.filter((entry) => entry === "repo" || entry === "status");
      return allowed.length ? allowed : ["repo", "status"];
    } catch {
      return ["repo", "status"];
    }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(GROUP_STORAGE, JSON.stringify(grouping));
  }, [grouping]);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = window.localStorage.getItem(COLLAPSE_STORAGE);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as Record<string, boolean>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(COLLAPSE_STORAGE, JSON.stringify(collapsed));
  }, [collapsed]);
  const toggleCollapsed = useCallback((nodePath: string) => {
    setCollapsed((prev) => {
      const next = { ...prev };
      if (next[nodePath]) delete next[nodePath];
      else next[nodePath] = true;
      return next;
    });
  }, []);

  const [showGroupBy, setShowGroupBy] = useState(false);
  const [showAddRepo, setShowAddRepo] = useState(false);

  // Intentionally exclude props.activeSummary from buildGroupTree: status sections
  // are derived from /api/state only, so the active workspace doesn't drift
  // between sections each time the per-workspace cockpit-summary refetches.
  const tree = useMemo(
    () => buildGroupTree(props.workspaces, props.repos, props.sessions, props.operations, grouping),
    [props.workspaces, props.repos, props.sessions, props.operations, grouping],
  );

  // Prune collapsed entries whose group no longer exists, so localStorage doesn't accumulate
  // orphans across repo/workspace renames or deletions. Skip when grouping is off or the tree
  // is empty, otherwise switching Group By off (or having no workspaces) would wipe everything.
  useEffect(() => {
    if (!grouping.length || !tree.length) return;
    setCollapsed((prev) => {
      const keys = Object.keys(prev);
      if (!keys.length) return prev;
      const live = collectGroupPaths(tree);
      let changed = false;
      const next: Record<string, boolean> = {};
      for (const key of keys) {
        if (live.has(key)) next[key] = prev[key] as boolean;
        else changed = true;
      }
      return changed ? next : prev;
    });
  }, [tree, grouping]);

  const renderWorkspace = useCallback(
    ({ workspace, sessions }: WorkspaceEntry) => (
      <WorkspaceCard
        key={workspace.id}
        workspace={workspace}
        sessions={sessions}
        pullRequest={
          workspace.id === props.activeSummary?.workspaceId
            ? (props.activeSummary.versionControl.pullRequest ?? null)
            : null
        }
        active={workspace.id === props.activeWorkspaceId}
        onSelect={() => props.onPickWorkspace(workspace)}
      />
    ),
    [props.activeSummary, props.activeWorkspaceId, props.onPickWorkspace],
  );

  const flatEntries = useMemo<WorkspaceEntry[]>(
    () =>
      props.workspaces.map((workspace) => ({
        workspace,
        sessions: props.sessions.filter((session) => session.workspaceId === workspace.id),
      })),
    [props.workspaces, props.sessions],
  );

  return (
    <>
      <div className="column-body">
        <nav className="nav-primary" aria-label="Primary navigation">
          <div className="nav-row">
            <Link to="/dashboard" className={path === "/dashboard" ? "active" : ""} title="Open kanban dashboard">
              <LayoutDashboard size={13} /> Dashboard
            </Link>
            <button
              type="button"
              className="nav-collapse"
              onClick={props.onCollapse}
              aria-label="Collapse navigator"
              title="Collapse navigator"
            >
              <PanelLeftClose size={14} />
            </button>
          </div>
          <Link
            to="/scratchpad"
            className={path === "/scratchpad" ? "active" : ""}
            title="Scratchpad — markdown notes orchestrator agents can read via MCP"
          >
            <NotebookPen size={13} /> Scratchpad
          </Link>
          <Link
            to="/scheduled-agents"
            className={path === "/scheduled-agents" ? "active" : ""}
            title="Scheduled agents — cron-driven agent runs"
          >
            <AlarmClock size={13} /> Scheduled agents
          </Link>
          <Link to="/history" className={path === "/history" ? "active" : ""} title="Activity & operations history">
            <ClipboardList size={13} /> History
          </Link>
        </nav>
        <div className="divider" />
        <div className="nav-section">
          <strong>Workspaces</strong>
          <div className="nav-section-icons">
            <button
              type="button"
              onClick={() => setShowGroupBy((v) => !v)}
              aria-label="Group workspaces"
              title="Group by"
            >
              <Settings2 size={12} />
            </button>
            <button
              type="button"
              onClick={() => setShowAddRepo(true)}
              aria-label="Add repository"
              title="Add repository"
            >
              <FolderPlus size={12} />
            </button>
            <button
              type="button"
              onClick={props.onOpenCreateWorkspace}
              aria-label="Create workspace"
              title="New workspace (press c)"
            >
              <Plus size={12} />
            </button>
            {showGroupBy ? (
              <GroupByOverlay value={grouping} onChange={setGrouping} onClose={() => setShowGroupBy(false)} />
            ) : null}
          </div>
        </div>
        <div className="nav-groups">
          {grouping.length === 0 ? (
            <div className="nav-group nav-group-flat">{flatEntries.map((entry) => renderWorkspace(entry))}</div>
          ) : (
            tree.map((node) => (
              <GroupNodeView
                key={node.id}
                node={node}
                depth={0}
                collapsed={collapsed}
                onToggle={toggleCollapsed}
                renderWorkspace={renderWorkspace}
              />
            ))
          )}
          {!props.workspaces.length ? (
            <div className="empty compact">No workspaces yet. Use the plus button above to create one.</div>
          ) : null}
        </div>
      </div>
      {showAddRepo ? <AddRepoModal onClose={() => setShowAddRepo(false)} /> : null}
      {props.createWorkspaceOpen ? (
        <CreateWorkspaceModal
          repos={props.repos}
          {...(props.lastRepoId ? { lastRepoId: props.lastRepoId } : {})}
          runtimes={props.runtimes}
          onClose={props.onCloseCreateWorkspace}
          onCreated={(workspaceId) => {
            props.onCloseCreateWorkspace();
            const created = props.workspaces.find((workspace) => workspace.id === workspaceId);
            if (created) props.onPickWorkspace(created);
          }}
        />
      ) : null}
    </>
  );
}

const DEPTH_INDENT_PX = 10;

function GroupNodeView(props: {
  node: GroupNode;
  depth: number;
  collapsed: Record<string, boolean>;
  onToggle: (path: string) => void;
  renderWorkspace: (entry: WorkspaceEntry) => React.ReactNode;
}) {
  const { node, depth, collapsed, onToggle, renderWorkspace } = props;
  const isCollapsed = collapsed[node.path] === true;
  // encodeURIComponent keeps DOM ids unique even when group labels contain spaces,
  // slashes, or other characters that would otherwise collapse to the same id.
  const headerId = `nav-group-${encodeURIComponent(node.path)}`;
  const bodyId = `${headerId}-body`;
  const style = depth > 0 ? { paddingLeft: depth * DEPTH_INDENT_PX } : undefined;
  return (
    <div className="nav-group" style={style}>
      <button
        type="button"
        id={headerId}
        className="nav-group-header"
        aria-expanded={!isCollapsed}
        aria-controls={bodyId}
        onClick={() => onToggle(node.path)}
      >
        <ChevronRight size={11} className={`nav-group-chevron ${isCollapsed ? "" : "open"}`} aria-hidden="true" />
        <span className="nav-group-label">{node.label}</span>
        <span className="nav-group-count" aria-label={`${node.count} workspaces`}>
          {node.count}
        </span>
      </button>
      {isCollapsed ? null : (
        <div id={bodyId} className="nav-group-body">
          {node.kind === "group"
            ? node.children.map((child) => (
                <GroupNodeView
                  key={child.id}
                  node={child}
                  depth={depth + 1}
                  collapsed={collapsed}
                  onToggle={onToggle}
                  renderWorkspace={renderWorkspace}
                />
              ))
            : node.workspaces.map((entry) => renderWorkspace(entry))}
        </div>
      )}
    </div>
  );
}
