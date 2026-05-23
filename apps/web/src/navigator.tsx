import type { AgentSession, Operation, Repo, Workspace, WorkspaceCockpitSummary } from "@citadel/contracts";
import { Link, useLocation } from "@tanstack/react-router";
import {
  ChevronRight,
  ClipboardList,
  FolderPlus,
  LayoutDashboard,
  PanelLeftClose,
  Plus,
  Settings2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { readinessForWorkspace, readinessSection } from "./cockpit-readiness.js";
import { formatLabel } from "./labels.js";
import { AddRepoModal, CreateWorkspaceModal, GroupByOverlay, type GroupKey } from "./modals.js";
import { WorkspaceCard } from "./workspace-card.js";

const GROUP_STORAGE = "citadel.navigator-group";
const COLLAPSE_STORAGE = "citadel.navigator-group-collapsed";

const SECTION_ORDER = ["blocked", "needs-review", "working", "dirty", "idle", "done"];

type WorkspaceEntry = { workspace: Workspace; sessions: AgentSession[] };

type GroupNode =
  | { kind: "group"; id: string; path: string; label: string; count: number; children: GroupNode[] }
  | { kind: "leaf"; id: string; path: string; label: string; count: number; workspaces: WorkspaceEntry[] };

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

  const tree = useMemo(
    () =>
      buildGroupTree(props.workspaces, props.repos, props.sessions, props.operations, props.activeSummary, grouping),
    [props.workspaces, props.repos, props.sessions, props.operations, props.activeSummary, grouping],
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
        active={workspace.id === props.activeWorkspaceId}
        onSelect={() => props.onPickWorkspace(workspace)}
      />
    ),
    [props.activeSummary, props.activeWorkspaceId, props.onPickWorkspace],
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
            <div className="nav-group nav-group-flat">
              {props.workspaces.map((workspace) =>
                renderWorkspace({
                  workspace,
                  sessions: props.sessions.filter((session) => session.workspaceId === workspace.id),
                }),
              )}
            </div>
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

function GroupNodeView(props: {
  node: GroupNode;
  depth: number;
  collapsed: Record<string, boolean>;
  onToggle: (path: string) => void;
  renderWorkspace: (entry: WorkspaceEntry) => React.ReactNode;
}) {
  const { node, depth, collapsed, onToggle, renderWorkspace } = props;
  const isCollapsed = collapsed[node.path] === true;
  const headerId = `nav-group-${node.path.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  return (
    <div className={`nav-group nav-group-depth-${depth}`}>
      <button
        type="button"
        className="nav-group-header"
        aria-expanded={!isCollapsed}
        aria-controls={`${headerId}-body`}
        onClick={() => onToggle(node.path)}
      >
        <ChevronRight size={11} className={`nav-group-chevron ${isCollapsed ? "" : "open"}`} aria-hidden="true" />
        <span className="nav-group-label">{node.label}</span>
        <span className="nav-group-count" aria-label={`${node.count} workspaces`}>
          {node.count}
        </span>
      </button>
      {isCollapsed ? null : (
        <div id={`${headerId}-body`} className="nav-group-body">
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

type EnrichedWorkspace = WorkspaceEntry & { repo: Repo | undefined; section: string };

function buildGroupTree(
  workspaces: Workspace[],
  repos: Repo[],
  sessions: AgentSession[],
  operations: Operation[],
  activeSummary: WorkspaceCockpitSummary | undefined,
  grouping: GroupKey[],
): GroupNode[] {
  if (!grouping.length) return [];

  const enriched: EnrichedWorkspace[] = workspaces.map((workspace) => {
    const workspaceSessions = sessions.filter((session) => session.workspaceId === workspace.id);
    const workspaceOps = operations.filter((operation) => operation.workspaceId === workspace.id);
    const summary = workspace.id === activeSummary?.workspaceId ? activeSummary : undefined;
    const attention = readinessForWorkspace(workspace, {
      sessions: workspaceSessions,
      operations: workspaceOps,
      summary,
    });
    const section = summary ? readinessSection(summary.readiness.state) : attention.section;
    const repo = repos.find((entry) => entry.id === workspace.repoId);
    return { workspace, sessions: workspaceSessions, repo, section };
  });

  const bucketKey = (entry: EnrichedWorkspace, field: GroupKey): string =>
    field === "repo" ? (entry.repo?.name ?? "Unknown repo") : formatLabel(entry.section ?? "idle");

  const sortKeys = (keys: string[], field: GroupKey): string[] =>
    keys.sort((a, b) => {
      if (field === "status") {
        const ai = SECTION_ORDER.indexOf(a.toLowerCase());
        const bi = SECTION_ORDER.indexOf(b.toLowerCase());
        return (ai < 0 ? SECTION_ORDER.length : ai) - (bi < 0 ? SECTION_ORDER.length : bi);
      }
      return a.localeCompare(b);
    });

  const build = (entries: EnrichedWorkspace[], levels: GroupKey[], parentPath: string): GroupNode[] => {
    if (!entries.length || !levels.length) return [];
    const head = levels[0] as GroupKey;
    const rest = levels.slice(1);
    const buckets = new Map<string, EnrichedWorkspace[]>();
    for (const entry of entries) {
      const key = bucketKey(entry, head);
      const list = buckets.get(key) ?? [];
      list.push(entry);
      buckets.set(key, list);
    }
    const ordered = sortKeys(Array.from(buckets.keys()), head);
    const nodes: GroupNode[] = [];
    for (const key of ordered) {
      const items = buckets.get(key);
      if (!items?.length) continue;
      const nodePath = parentPath ? `${parentPath}/${head}=${key}` : `${head}=${key}`;
      const nodeId = nodePath;
      if (rest.length === 0) {
        nodes.push({
          kind: "leaf",
          id: nodeId,
          path: nodePath,
          label: key,
          count: items.length,
          workspaces: items.map(({ workspace, sessions: ws }) => ({ workspace, sessions: ws })),
        });
      } else {
        const children = build(items, rest, nodePath);
        if (!children.length) continue;
        nodes.push({
          kind: "group",
          id: nodeId,
          path: nodePath,
          label: key,
          count: items.length,
          children,
        });
      }
    }
    return nodes;
  };

  return build(enriched, grouping, "");
}
