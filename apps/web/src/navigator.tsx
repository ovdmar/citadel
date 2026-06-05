import type {
  Namespace,
  Operation,
  PullRequestSummary,
  Repo,
  Workspace,
  WorkspaceSession,
  WorktreeCheckout,
} from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import {
  AlarmClock,
  Bot,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  ClipboardList,
  FolderPlus,
  LayoutDashboard,
  NotebookPen,
  PanelLeftClose,
  Plus,
  Settings2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AddRepoModal } from "./add-repo-modal.js";
import { api, queryClient } from "./api.js";
import { type CreateWorkspaceIntent, CreateWorkspaceModal, GroupByMenu } from "./modals.js";
import {
  COLLAPSE_STORAGE_KEY as COLLAPSE_STORAGE,
  GROUP_STORAGE_KEY as GROUP_STORAGE,
  publishNavigatorGroupingChanged,
  readCollapsedMap,
  readNavigatorGrouping,
  subscribeToCollapseChanges,
} from "./navigator-collapse-store.js";
import {
  type GroupNode,
  type GroupableKey,
  type NavigatorGrouping,
  type WorkspaceEntry,
  buildGroupTree,
  collectGroupPaths,
  treeGroupingFor,
} from "./navigator-groups.js";
import { applyLocalOrder, loadOrder, pruneOrder, saveOrder, spliceIntoOrder } from "./navigator-order.js";
import {
  type CheckoutPrStateByWorkspace,
  aggregateNavigatorTone,
  aggregateWorkspacePrState,
  checkoutPullRequest,
} from "./navigator-pr-state.js";
import {
  checkoutMatchesRepoGroup,
  currentRepoGroupNameFromPath,
  repoByGroupName,
  repoGroupNameFromPath,
} from "./navigator-repo-groups.js";
import {
  CheckoutNavCard,
  checkoutSessions,
  hasNestedCheckouts,
  workspaceCheckoutRows,
} from "./navigator-workspace-cards.js";
import { useScratchpadDrawer } from "./scratchpad-drawer-store.js";
import { WorkspaceCard, lifecycleToneClass } from "./workspace-card.js";

export { aggregateNavigatorTone };

function runningCount(sessions: WorkspaceSession[]): number {
  return sessions.filter((session) => session.kind === "agent" && session.status === "running").length;
}

function groupingLabel(grouping: NavigatorGrouping): string {
  return grouping.map((key) => (key === "repo" ? "repository" : key)).join(" → ");
}

export function Navigator(props: {
  repos: Repo[];
  workspaces: Workspace[];
  checkouts: WorktreeCheckout[];
  sessions: WorkspaceSession[];
  operations: Operation[];
  prByWorkspaceId: Map<string, PullRequestSummary | null>;
  checkoutPrByWorkspaceId: CheckoutPrStateByWorkspace;
  activeWorkspaceId: string;
  activeTargetKey: string;
  runtimes: import("@citadel/contracts").AgentRuntime[];
  namespaces: Namespace[];
  lastRepoId: string | undefined;
  createWorkspaceOpen: boolean;
  onOpenCreateWorkspace: () => void;
  onCloseCreateWorkspace: () => void;
  onCollapse: () => void;
  onPickWorkspace: (workspace: Workspace) => void;
  onPickWorkspaceId: (workspaceId: string) => void;
  onPickTarget: (workspaceId: string, targetKey: string) => void;
}) {
  const location = useLocation();
  const path = location.pathname;
  const [grouping, setGrouping] = useState<NavigatorGrouping>(() => readNavigatorGrouping());
  const [createWorkspaceIntent, setCreateWorkspaceIntent] = useState<CreateWorkspaceIntent>({ kind: "auto" });
  const openCreateWorkspace = useCallback(
    (intent: CreateWorkspaceIntent = { kind: "auto" }) => {
      setCreateWorkspaceIntent(intent);
      props.onOpenCreateWorkspace();
    },
    [props.onOpenCreateWorkspace],
  );
  const closeCreateWorkspace = useCallback(() => {
    setCreateWorkspaceIntent({ kind: "auto" });
    props.onCloseCreateWorkspace();
  }, [props.onCloseCreateWorkspace]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(GROUP_STORAGE, JSON.stringify(grouping));
    // Notify same-tab consumers (the cockpit's flatWorkspaceIds memo) that the
    // grouping changed — the browser's `storage` event only fires across tabs.
    publishNavigatorGroupingChanged();
  }, [grouping]);

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => readCollapsedMap());
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(COLLAPSE_STORAGE, JSON.stringify(collapsed));
  }, [collapsed]);
  // External writers (e.g. cockpit nav shortcuts that auto-expand a group)
  // mutate the same localStorage key and broadcast a custom event. Re-read
  // and replace local state so the navigator visibly reflects the change.
  useEffect(() => subscribeToCollapseChanges(() => setCollapsed(readCollapsedMap())), []);
  const toggleCollapsed = useCallback((nodePath: string) => {
    setCollapsed((prev) => {
      const next = { ...prev };
      if (next[nodePath]) delete next[nodePath];
      else next[nodePath] = true;
      return next;
    });
  }, []);
  const [collapsedWorkspaceCheckouts, setCollapsedWorkspaceCheckouts] = useState<Record<string, boolean>>({});
  const toggleWorkspaceCheckouts = useCallback((workspaceId: string) => {
    setCollapsedWorkspaceCheckouts((prev) => ({ ...prev, [workspaceId]: !prev[workspaceId] }));
  }, []);
  const groupingIncludesRepo = grouping.includes("repo");
  const collapsibleWorkspaceIds = useMemo(() => {
    if (groupingIncludesRepo) return [];
    const workspaceIdsWithCheckouts = new Set(
      props.checkouts.filter((checkout) => !checkout.archivedAt).map((checkout) => checkout.workspaceId),
    );
    return props.workspaces
      .filter((workspace) => workspaceIdsWithCheckouts.has(workspace.id))
      .map((workspace) => workspace.id);
  }, [groupingIncludesRepo, props.checkouts, props.workspaces]);
  const allWorkspaceCheckoutsCollapsed =
    collapsibleWorkspaceIds.length > 0 &&
    collapsibleWorkspaceIds.every((workspaceId) => collapsedWorkspaceCheckouts[workspaceId] === true);
  const checkoutBulkAction = allWorkspaceCheckoutsCollapsed ? "expand" : "collapse";
  const toggleAllWorkspaceCheckouts = useCallback(() => {
    setCollapsedWorkspaceCheckouts((prev) => {
      const next = { ...prev };
      if (checkoutBulkAction === "collapse") {
        for (const workspaceId of collapsibleWorkspaceIds) next[workspaceId] = true;
      } else {
        for (const workspaceId of collapsibleWorkspaceIds) delete next[workspaceId];
      }
      return next;
    });
  }, [checkoutBulkAction, collapsibleWorkspaceIds]);

  const [showGroupBy, setShowGroupBy] = useState(false);
  const groupByContainerRef = useRef<HTMLDivElement | null>(null);
  const [showAddRepo, setShowAddRepo] = useState(false);

  // Per-group user-defined ordering, persisted in localStorage. Keyed by
  // group path so switching grouping (repo ↔ status ↔ namespace ↔ none)
  // selects a different order bucket and doesn't bleed across modes.
  const [navigatorOrder, setNavigatorOrder] = useState<Record<string, string[]>>(() => loadOrder());
  useEffect(() => saveOrder(navigatorOrder), [navigatorOrder]);
  // Prune stale workspace ids on mount + whenever the workspace list
  // changes, so dropped/removed workspaces don't linger in the order map.
  useEffect(() => {
    const liveIds = new Set(props.workspaces.map((w) => w.id));
    setNavigatorOrder((prev) => pruneOrder(prev, liveIds));
  }, [props.workspaces]);

  const reorderWorkspace = useCallback(
    (groupPath: string, visibleIds: readonly string[], draggedId: string, targetIndex: number) => {
      setNavigatorOrder((prev) => ({
        ...prev,
        [groupPath]: spliceIntoOrder(visibleIds, draggedId, targetIndex),
      }));
    },
    [],
  );

  // Intentionally exclude props.activeSummary from buildGroupTree: status sections
  // are derived from /api/state only, so the active workspace doesn't drift
  // between sections each time the per-workspace cockpit-summary refetches.
  // User-selected grouping levels nest in order. "workspace" is the default
  // leaf/root workspace-card mode, so it is filtered out before tree building.
  const treeGrouping = useMemo<GroupableKey[]>(() => treeGroupingFor(grouping), [grouping]);
  const tree = useMemo(
    () =>
      buildGroupTree(
        props.workspaces,
        props.repos,
        props.sessions,
        props.operations,
        treeGrouping,
        props.namespaces,
        props.checkouts,
      ),
    [props.workspaces, props.repos, props.sessions, props.operations, treeGrouping, props.namespaces, props.checkouts],
  );
  const historyCount = props.operations.length;
  const navigatorTone = aggregateNavigatorTone(
    props.workspaces,
    props.sessions,
    props.prByWorkspaceId,
    props.checkouts,
    props.checkoutPrByWorkspaceId,
  );
  const running = runningCount(props.sessions);

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
  const hideMainWorkspace = useMutation({
    mutationFn: (repoId: string) =>
      api(`/api/repos/${repoId}`, {
        method: "PATCH",
        body: JSON.stringify({ showMainWorkspace: false }),
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
    ({ workspace, sessions }: WorkspaceEntry, groupPath: string, visibleIds: readonly string[]) => {
      const checkouts = props.checkouts.filter(
        (checkout) => checkout.workspaceId === workspace.id && !checkout.archivedAt,
      );
      const { visibleCheckouts, aggregateCheckouts } = workspaceCheckoutRows(workspace, checkouts);
      const nested = hasNestedCheckouts(visibleCheckouts);
      const aggregateRow = nested || (aggregateCheckouts.length > 0 && visibleCheckouts.length === 0);
      const workspaceCheckout = visibleCheckouts.length === 1 ? visibleCheckouts[0] : null;
      const activeWorkspace = workspace.id === props.activeWorkspaceId;
      const structuredHome = workspace.kind === "root" && workspace.mode === "structured";
      const mainRepoWorkspace =
        workspace.kind === "root" && workspace.repoId !== null && workspace.mode !== "structured";
      const workspacePullRequest = props.prByWorkspaceId.get(workspace.id) ?? null;
      const checkoutPrState = props.checkoutPrByWorkspaceId.get(workspace.id);
      const prAggregate = aggregateWorkspacePrState({
        checkouts: aggregateCheckouts,
        workspacePullRequest,
        checkoutPrState,
      });
      const checkoutsCollapsed = collapsedWorkspaceCheckouts[workspace.id] === true;
      const checkoutListId = `nav-workspace-checkouts-${encodeURIComponent(workspace.id)}`;
      const repoGroupName = repoGroupNameFromPath(groupPath);
      const canAttachCheckout = structuredHome && props.repos.length > 0;
      const canHideMainWorkspace = mainRepoWorkspace && workspace.repoId !== null;
      if (nested && repoGroupName) {
        const repoGroupedCheckouts = visibleCheckouts.filter((checkout) =>
          checkoutMatchesRepoGroup(checkout, repoGroupName, props.repos),
        );
        if (!repoGroupedCheckouts.length) return null;
        return (
          <div
            key={`${workspace.id}:${repoGroupName}`}
            className="nav-workspace-checkouts nav-workspace-checkouts--repo-grouped"
            aria-label={`${repoGroupName} worktrees`}
          >
            {repoGroupedCheckouts.map((checkout) => {
              const repo = props.repos.find((entry) => entry.id === checkout.repoId) ?? null;
              const targetKey = `checkout:${checkout.id}`;
              return (
                <CheckoutNavCard
                  key={checkout.id}
                  workspace={workspace}
                  checkout={checkout}
                  repo={repo}
                  sessions={checkoutSessions(sessions, checkout.id)}
                  pullRequest={checkoutPullRequest({ checkout, workspacePullRequest, checkoutPrState })}
                  active={activeWorkspace && props.activeTargetKey === targetKey}
                  onSelect={() => props.onPickTarget(workspace.id, targetKey)}
                />
              );
            })}
          </div>
        );
      }
      const cardWorkspace = nested
        ? {
            ...workspace,
            repoId: workspaceCheckout?.repoId ?? workspace.repoId,
          }
        : workspace;
      const cardActive = activeWorkspace && (props.activeTargetKey === "home" || (nested && checkoutsCollapsed));
      return (
        <div key={workspace.id} className="nav-workspace-target-wrap">
          <WorkspaceCard
            workspace={cardWorkspace}
            sessions={sessions.filter((session) => !session.closedAt)}
            operation={
              props.operations
                .filter((operation) => operation.workspaceId === workspace.id && operation.type === "workspace.create")
                .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null
            }
            pullRequest={aggregateRow ? null : workspacePullRequest}
            approval={aggregateRow ? prAggregate.approval : undefined}
            namespace={
              treeGrouping.includes("namespace")
                ? null
                : workspace.namespaceId
                  ? (namespacesById.get(workspace.namespaceId) ?? null)
                  : null
            }
            namespaces={props.namespaces}
            dropTarget={treeGrouping.includes("namespace") ? "namespace" : null}
            reorder={{
              groupPath,
              visibleIds,
              onReorder: (draggedId, targetIndex) => reorderWorkspace(groupPath, visibleIds, draggedId, targetIndex),
            }}
            active={cardActive}
            onSelect={() => props.onPickTarget(workspace.id, "home")}
            branchLabel={aggregateRow || structuredHome ? null : undefined}
            prToneOverride={aggregateRow ? prAggregate.prTone : undefined}
            diffOverride={
              aggregateRow ? { additions: prAggregate.additions, deletions: prAggregate.deletions } : undefined
            }
            allowRootDrop={structuredHome}
            rightControl={
              canHideMainWorkspace || canAttachCheckout || nested ? (
                <>
                  {canHideMainWorkspace ? (
                    <button
                      type="button"
                      className="workspace-card-collapse"
                      aria-label={`Hide ${workspace.name} from navigation`}
                      title="Hide main repo location"
                      onClick={(event) => {
                        event.stopPropagation();
                        hideMainWorkspace.mutate(workspace.repoId as string);
                      }}
                    >
                      <X size={12} aria-hidden="true" />
                    </button>
                  ) : null}
                  {canAttachCheckout ? (
                    <button
                      type="button"
                      className="workspace-card-collapse"
                      aria-label={`Add worktree to ${workspace.name}`}
                      title="Add worktree"
                      onClick={(event) => {
                        event.stopPropagation();
                        openCreateWorkspace({
                          kind: "attach-worktree",
                          workspaceId: workspace.id,
                          workspaceName: workspace.name,
                        });
                      }}
                    >
                      <Plus size={12} aria-hidden="true" />
                    </button>
                  ) : null}
                  {nested ? (
                    <button
                      type="button"
                      className="workspace-card-collapse"
                      aria-label={`${checkoutsCollapsed ? "Expand" : "Collapse"} ${workspace.name} worktrees`}
                      aria-controls={checkoutListId}
                      aria-expanded={!checkoutsCollapsed}
                      title={`${checkoutsCollapsed ? "Expand" : "Collapse"} worktrees`}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggleWorkspaceCheckouts(workspace.id);
                      }}
                    >
                      <ChevronRight
                        size={12}
                        className={`workspace-card-collapse-icon ${checkoutsCollapsed ? "" : "open"}`}
                        aria-hidden="true"
                      />
                    </button>
                  ) : null}
                </>
              ) : null
            }
          />
          {nested ? (
            <div
              id={checkoutListId}
              className="nav-workspace-checkouts"
              aria-label={`${workspace.name} worktrees`}
              hidden={checkoutsCollapsed}
            >
              {visibleCheckouts.map((checkout) => {
                const repo = props.repos.find((entry) => entry.id === checkout.repoId) ?? null;
                const targetKey = `checkout:${checkout.id}`;
                return (
                  <CheckoutNavCard
                    key={checkout.id}
                    workspace={workspace}
                    checkout={checkout}
                    repo={repo}
                    sessions={checkoutSessions(sessions, checkout.id)}
                    pullRequest={checkoutPullRequest({ checkout, workspacePullRequest, checkoutPrState })}
                    active={activeWorkspace && props.activeTargetKey === targetKey}
                    onSelect={() => props.onPickTarget(workspace.id, targetKey)}
                  />
                );
              })}
            </div>
          ) : null}
        </div>
      );
    },
    [
      props.checkouts,
      props.prByWorkspaceId,
      props.checkoutPrByWorkspaceId,
      props.repos,
      props.operations,
      props.activeWorkspaceId,
      props.activeTargetKey,
      openCreateWorkspace,
      props.onPickTarget,
      props.namespaces,
      namespacesById,
      treeGrouping,
      reorderWorkspace,
      collapsedWorkspaceCheckouts,
      toggleWorkspaceCheckouts,
      hideMainWorkspace,
    ],
  );
  const flatEntries = useMemo<WorkspaceEntry[]>(
    () =>
      props.workspaces.map((workspace) => ({
        workspace,
        sessions: props.sessions.filter((session) => session.workspaceId === workspace.id),
      })),
    [props.workspaces, props.sessions],
  );
  const hasVisibleWorkspaceEntries = treeGrouping.length === 0 ? props.workspaces.length > 0 : tree.length > 0;

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
          <Link to="/agents" className={path === "/agents" ? "active" : ""} title="Agent role templates">
            <Bot size={13} /> Agents
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
            <button
              type="button"
              onClick={toggleAllWorkspaceCheckouts}
              disabled={!collapsibleWorkspaceIds.length}
              aria-label={`${checkoutBulkAction === "collapse" ? "Collapse" : "Expand"} all workspace worktrees`}
              title={
                collapsibleWorkspaceIds.length
                  ? `${checkoutBulkAction === "collapse" ? "Collapse" : "Expand"} all worktrees`
                  : "No worktrees to collapse"
              }
            >
              {checkoutBulkAction === "collapse" ? <ChevronsDownUp size={12} /> : <ChevronsUpDown size={12} />}
            </button>
            <div className="cit-gb" ref={groupByContainerRef}>
              <button
                type="button"
                className={`cit-icon-btn cit-icon-btn--sm cit-gb-btn ${showGroupBy ? "is-open" : ""}`}
                onClick={() => setShowGroupBy((v) => !v)}
                aria-label="Group worktrees"
                title={`Group worktrees by: ${groupingLabel(grouping)}`}
              >
                <Settings2 size={12} />
              </button>
              {showGroupBy ? (
                <GroupByMenu
                  value={grouping}
                  onChange={setGrouping}
                  onClose={() => setShowGroupBy(false)}
                  containerRef={groupByContainerRef}
                />
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
              onClick={() => openCreateWorkspace()}
              aria-label="Create workspace"
              title="New workspace (press c)"
            >
              <Plus size={12} />
            </button>
          </div>
        </div>
        <div className="nav-groups">
          {treeGrouping.length === 0
            ? (() => {
                const groupPath = "__flat";
                const orderedFlat = applyLocalOrder(flatEntries, navigatorOrder[groupPath]);
                const visibleIds = orderedFlat.map((entry) => entry.workspace.id);
                return (
                  <div className="nav-group nav-group-flat">
                    {orderedFlat.map((entry) => renderWorkspace(entry, groupPath, visibleIds))}
                  </div>
                );
              })()
            : tree.map((node) => (
                <GroupNodeView
                  key={node.id}
                  node={node}
                  depth={0}
                  collapsed={collapsed}
                  onToggle={toggleCollapsed}
                  renderWorkspace={renderWorkspace}
                  navigatorOrder={navigatorOrder}
                  dropTargetPath={dropTargetPath}
                  onDropTargetChange={setDropTargetPath}
                  onDropOnNamespace={onDropOnNamespace}
                  repos={props.repos}
                />
              ))}
          {!hasVisibleWorkspaceEntries ? (
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
              <span className={`cit-pulse cit-pulse-sm ${lifecycleToneClass(navigatorTone)}`} aria-hidden />
              {running}
            </div>
          </div>
        </div>
      </div>
      {showAddRepo ? <AddRepoModal onClose={() => setShowAddRepo(false)} /> : null}
      {props.createWorkspaceOpen ? (
        <CreateWorkspaceModal
          repos={props.repos}
          {...(props.lastRepoId ? { lastRepoId: props.lastRepoId } : {})}
          grouping={grouping}
          intent={createWorkspaceIntent}
          onClose={closeCreateWorkspace}
          onCreated={(workspaceId) => {
            closeCreateWorkspace();
            const created = props.workspaces.find((workspace) => workspace.id === workspaceId);
            if (created) props.onPickWorkspace(created);
            else props.onPickWorkspaceId(workspaceId);
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
  renderWorkspace: (entry: WorkspaceEntry, groupPath: string, visibleIds: readonly string[]) => React.ReactNode;
  // Per-group user-defined ordering map (keyed by node.path), consumed in
  // the leaf branch via applyLocalOrder before rendering workspace cards.
  navigatorOrder: Record<string, string[]>;
  // Namespace leaves accept workspace drops; non-namespace groupings simply
  // ignore these.
  dropTargetPath: string | null;
  onDropTargetChange: (path: string | null) => void;
  onDropOnNamespace: (event: React.DragEvent, namespaceId: string | null) => void;
  repos: Repo[];
};

function GroupNodeView(props: GroupNodeViewProps) {
  const {
    node,
    depth,
    collapsed,
    onToggle,
    renderWorkspace,
    navigatorOrder,
    dropTargetPath,
    onDropTargetChange,
    onDropOnNamespace,
    repos,
  } = props;
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
  const currentRepo = repoByGroupName(currentRepoGroupNameFromPath(node.path), repos);
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
        <span className="nav-group-label-stack">
          <span className="nav-group-label">{node.label}</span>
          {currentRepo ? (
            <span className="nav-group-sub" title={currentRepo.rootPath}>
              {currentRepo.rootPath}
            </span>
          ) : null}
        </span>
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
                navigatorOrder={navigatorOrder}
                dropTargetPath={dropTargetPath}
                onDropTargetChange={onDropTargetChange}
                onDropOnNamespace={onDropOnNamespace}
                repos={repos}
              />
            ))
          ) : node.workspaces.length ? (
            (() => {
              // Apply the per-group user-defined order before rendering.
              // The visibleIds list is recomputed here so card reorder
              // callbacks have the current rendered sequence to splice into.
              const ordered = applyLocalOrder(node.workspaces, navigatorOrder[node.path]);
              const visibleIds = ordered.map((entry) => entry.workspace.id);
              return ordered.map((entry) => renderWorkspace(entry, node.path, visibleIds));
            })()
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
