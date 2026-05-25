import type { AgentSession, Namespace, Operation, Repo, Workspace, WorkspaceCockpitSummary } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
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
import { api, queryClient } from "./api.js";
import { AddRepoModal, CreateWorkspaceModal, GroupByMenu, type GroupKey } from "./modals.js";
import { useScratchpadDrawer } from "./scratchpad-drawer-store.js";
import {
  type GroupNode,
  type GroupableKey,
  type WorkspaceEntry,
  buildGroupTree,
  collectGroupPaths,
} from "./navigator-groups.js";
import { WorkspaceCard } from "./workspace-card.js";

const GROUP_STORAGE = "citadel.navigator-group";
const COLLAPSE_STORAGE = "citadel.navigator-group-collapsed";

function runningCount(sessions: AgentSession[]): number {
  return sessions.filter((session) => session.status === "running").length;
}

export function Navigator(props: {
  repos: Repo[];
  workspaces: Workspace[];
  sessions: AgentSession[];
  operations: Operation[];
  activeSummary: WorkspaceCockpitSummary | undefined;
  activeWorkspaceId: string;
  runtimes: import("@citadel/contracts").AgentRuntime[];
  namespaces: Namespace[];
  lastRepoId: string | undefined;
  createWorkspaceOpen: boolean;
  onOpenCreateWorkspace: () => void;
  onCloseCreateWorkspace: () => void;
  onCollapse: () => void;
  onPickWorkspace: (workspace: Workspace) => void;
}) {
  const location = useLocation();
  const path = location.pathname;
  const [grouping, setGrouping] = useState<GroupKey>(() => {
    if (typeof window === "undefined") return "repo";
    const raw = window.localStorage.getItem(GROUP_STORAGE);
    if (raw === "repo" || raw === "status" || raw === "namespace" || raw === "none") return raw;
    // Migration: legacy storage held an array like ["repo","status"]; collapse
    // to the first entry, otherwise default to "repo".
    if (raw?.startsWith("[")) {
      try {
        const parsed = JSON.parse(raw) as unknown[];
        const first = parsed[0];
        if (first === "repo" || first === "status" || first === "namespace" || first === "none") return first;
      } catch {
        // fall through to default
      }
    }
    return "repo";
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(GROUP_STORAGE, grouping);
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
  // Namespace mode renders as a two-level tree (repo → namespace) so two
  // workspaces named "main" in different repos don't collapse into a single
  // ambiguous bucket. The tree builder handles namespace bucketing natively.
  const treeGrouping = useMemo<GroupableKey[]>(
    () => (grouping === "none" ? [] : grouping === "namespace" ? ["repo", "namespace"] : [grouping as GroupableKey]),
    [grouping],
  );
  const tree = useMemo(
    () =>
      buildGroupTree(props.workspaces, props.repos, props.sessions, props.operations, treeGrouping, props.namespaces),
    [props.workspaces, props.repos, props.sessions, props.operations, treeGrouping, props.namespaces],
  );
  const historyCount = props.operations.length;

  // Prune collapsed entries whose group no longer exists, so localStorage doesn't accumulate
  // orphans across repo/workspace renames or deletions. Skip when grouping is off or the tree
  // is empty, otherwise switching Group By off (or having no workspaces) would wipe everything.
  useEffect(() => {
    if (!treeGrouping.length || !tree.length) return;
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
  }, [tree, treeGrouping]);

  const namespacesById = useMemo(() => {
    const map = new Map<string, Namespace>();
    for (const namespace of props.namespaces) map.set(namespace.id, namespace);
    return map;
  }, [props.namespaces]);

  const assignNamespace = useMutation({
    mutationFn: (input: { workspaceId: string; namespaceId: string | null }) =>
      api("/api/namespaces/assign", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const onDropOnNamespace = useCallback(
    (event: React.DragEvent, namespaceId: string | null) => {
      event.preventDefault();
      setDropTargetPath(null);
      const workspaceId = event.dataTransfer.getData("application/x-citadel-workspace-id");
      if (!workspaceId) return;
      const workspace = props.workspaces.find((entry) => entry.id === workspaceId);
      if (!workspace || workspace.namespaceId === namespaceId) return;
      assignNamespace.mutate({ workspaceId, namespaceId });
    },
    [assignNamespace, props.workspaces],
  );

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
        namespace={workspace.namespaceId ? (namespacesById.get(workspace.namespaceId) ?? null) : null}
        namespaces={props.namespaces}
        active={workspace.id === props.activeWorkspaceId}
        draggable={grouping === "namespace"}
        onSelect={() => props.onPickWorkspace(workspace)}
      />
    ),
    [props.activeSummary, props.activeWorkspaceId, props.onPickWorkspace, props.namespaces, namespacesById, grouping],
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
          <ScratchpadNavLink />
          <Link
            to="/scheduled-agents"
            className={path === "/scheduled-agents" ? "active" : ""}
            title="Scheduled agents — cron-driven agent runs"
          >
            <AlarmClock size={13} /> Scheduled agents
          </Link>
          <Link to="/history" className={path === "/history" ? "active" : ""} title="Activity & operations history">
            <ClipboardList size={13} /> <span>History</span>
            {historyCount > 0 ? <span className="cit-nav-count">{historyCount}</span> : null}
          </Link>
        </nav>
        <div className="divider" />
        <div className="nav-section">
          <strong>Workspaces</strong>
          <div className="nav-section-icons">
            <div className="cit-gb">
              <button
                type="button"
                className={`cit-icon-btn cit-icon-btn--sm cit-gb-btn ${showGroupBy ? "is-open" : ""}`}
                onClick={() => setShowGroupBy((v) => !v)}
                aria-label="Group workspaces"
                title={`Group by: ${grouping === "none" ? "no grouping" : grouping}`}
              >
                <Settings2 size={12} />
              </button>
              {showGroupBy ? (
                <GroupByMenu value={grouping} onChange={setGrouping} onClose={() => setShowGroupBy(false)} />
              ) : null}
            </div>
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
          </div>
        </div>
        <div className="nav-groups">
          {grouping === "none" ? (
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
                dropTargetPath={dropTargetPath}
                onDropTargetChange={setDropTargetPath}
                onDropOnNamespace={onDropOnNamespace}
              />
            ))
          )}
          {!props.workspaces.length ? (
            <div className="empty compact">
              {props.repos.length
                ? "No workspaces yet. Use the plus button above to create one."
                : "No repositories registered yet. Use the folder button above to register one."}
            </div>
          ) : null}
        </div>
        <div className="nav-foot">
          <div className="nav-foot-stat">
            <div className="nav-foot-stat-label">Workspaces</div>
            <div className="nav-foot-stat-val">{props.workspaces.length}</div>
          </div>
          <div className="nav-foot-stat">
            <div className="nav-foot-stat-label">Running</div>
            <div className="nav-foot-stat-val">
              <span
                className={`cit-pulse cit-pulse-sm ${runningCount(props.sessions) ? "cit-pulse-run" : "cit-pulse-idle"}`}
                aria-hidden
              />
              {runningCount(props.sessions)}
            </div>
          </div>
        </div>
      </div>
      {showAddRepo ? <AddRepoModal onClose={() => setShowAddRepo(false)} /> : null}
      {props.createWorkspaceOpen ? (
        <CreateWorkspaceModal
          repos={props.repos}
          {...(props.lastRepoId ? { lastRepoId: props.lastRepoId } : {})}
          runtimes={props.runtimes}
          namespaces={props.namespaces}
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

type GroupNodeViewProps = {
  node: GroupNode;
  depth: number;
  collapsed: Record<string, boolean>;
  onToggle: (path: string) => void;
  renderWorkspace: (entry: WorkspaceEntry) => React.ReactNode;
  // Namespace leaves accept workspace drops; non-namespace groupings simply
  // ignore these.
  dropTargetPath: string | null;
  onDropTargetChange: (path: string | null) => void;
  onDropOnNamespace: (event: React.DragEvent, namespaceId: string | null) => void;
};

function GroupNodeView(props: GroupNodeViewProps) {
  const { node, depth, collapsed, onToggle, renderWorkspace, dropTargetPath, onDropTargetChange, onDropOnNamespace } =
    props;
  const isCollapsed = collapsed[node.path] === true;
  // encodeURIComponent keeps DOM ids unique even when group labels contain spaces,
  // slashes, or other characters that would otherwise collapse to the same id.
  const headerId = `nav-group-${encodeURIComponent(node.path)}`;
  const bodyId = `${headerId}-body`;
  const style = depth > 0 ? { paddingLeft: depth * DEPTH_INDENT_PX } : undefined;
  // Namespace leaves carry namespaceId (null === "Uncategorized" drop target).
  const acceptsDrop = node.kind === "leaf" && node.namespaceId !== undefined;
  const isDropHover = acceptsDrop && dropTargetPath === node.path;
  const dropHandlers = acceptsDrop
    ? {
        onDragOver: (event: React.DragEvent) => {
          if (event.dataTransfer.types.includes("application/x-citadel-workspace-id")) {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            onDropTargetChange(node.path);
          }
        },
        onDragLeave: () => onDropTargetChange(null),
        onDrop: (event: React.DragEvent) => onDropOnNamespace(event, node.namespaceId ?? null),
      }
    : {};
  return (
    <div className={`nav-group ${isDropHover ? "drop-hover" : ""}`} style={style} {...dropHandlers}>
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
          {node.kind === "group" ? (
            node.children.map((child) => (
              <GroupNodeView
                key={child.id}
                node={child}
                depth={depth + 1}
                collapsed={collapsed}
                onToggle={onToggle}
                renderWorkspace={renderWorkspace}
                dropTargetPath={dropTargetPath}
                onDropTargetChange={onDropTargetChange}
                onDropOnNamespace={onDropOnNamespace}
              />
            ))
          ) : node.workspaces.length ? (
            node.workspaces.map((entry) => renderWorkspace(entry))
          ) : acceptsDrop ? (
            <div className="nav-group-empty">Drop a workspace here</div>
          ) : null}
        </div>
      )}
    </div>
  );
}

function ScratchpadNavLink() {
  const { open, toggle } = useScratchpadDrawer();
  const isMac =
    typeof navigator !== "undefined" && /Mac|iPod|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const hint = isMac ? "Shift+Cmd+S" : "Shift+Ctrl+S";
  return (
    <button
      type="button"
      className={`nav-link-button${open ? " active" : ""}`}
      onClick={toggle}
      title={`Scratchpad — markdown notes orchestrator agents can read via MCP (${hint})`}
      aria-pressed={open}
    >
      <NotebookPen size={13} /> Scratchpad
      <kbd className="nav-kbd-hint" aria-hidden>
        {hint}
      </kbd>
    </button>
  );
}
