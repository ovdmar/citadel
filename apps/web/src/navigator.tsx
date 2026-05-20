import type { AgentSession, Operation, Repo, Workspace, WorkspaceCockpitSummary } from "@citadel/contracts";
import { Link, useLocation } from "@tanstack/react-router";
import { ClipboardList, FolderPlus, LayoutDashboard, PanelLeftClose, Plus, Settings2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { readinessForWorkspace, readinessSection } from "./cockpit-readiness.js";
import { Button } from "./components/ui/button.js";
import { formatLabel } from "./labels.js";
import { AddRepoModal, CreateWorkspaceModal, GroupByOverlay, type GroupKey } from "./modals.js";
import { WorkspaceCard } from "./workspace-card.js";

const GROUP_STORAGE = "citadel.navigator-group";

const SECTION_ORDER = ["blocked", "needs-review", "working", "dirty", "idle", "done"];

export function Navigator(props: {
  repos: Repo[];
  workspaces: Workspace[];
  sessions: AgentSession[];
  operations: Operation[];
  activeSummary: WorkspaceCockpitSummary | undefined;
  activeWorkspaceId: string;
  runtimes: import("@citadel/contracts").AgentRuntime[];
  lastRepoId: string | undefined;
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

  const [showGroupBy, setShowGroupBy] = useState(false);
  const [showAddRepo, setShowAddRepo] = useState(false);
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);

  const grouped = useMemo(
    () => buildGroups(props.workspaces, props.repos, props.sessions, props.operations, props.activeSummary, grouping),
    [props.workspaces, props.repos, props.sessions, props.operations, props.activeSummary, grouping],
  );

  return (
    <>
      <div className="column-header">
        <strong>Citadel</strong>
        <span className="header-spacer" />
        <Button type="button" variant="ghost" size="icon" onClick={props.onCollapse} aria-label="Collapse navigator">
          <PanelLeftClose size={14} />
        </Button>
      </div>
      <div className="column-body">
        <nav className="nav-primary" aria-label="Primary navigation">
          <Link to="/dashboard" className={path === "/dashboard" ? "active" : ""}>
            <LayoutDashboard size={13} /> Dashboard
          </Link>
          <Link to="/history" className={path === "/history" ? "active" : ""}>
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
              onClick={() => setShowCreateWorkspace(true)}
              aria-label="Create workspace"
              title="New workspace"
            >
              <Plus size={12} />
            </button>
            {showGroupBy ? (
              <GroupByOverlay value={grouping} onChange={setGrouping} onClose={() => setShowGroupBy(false)} />
            ) : null}
          </div>
        </div>
        {grouped.map((section) => (
          <div key={section.id} className="nav-group">
            {section.label ? <div className="nav-group-header">{section.label}</div> : null}
            {section.workspaces.length ? (
              section.workspaces.map(({ workspace, sessions }) => (
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
              ))
            ) : (
              <div className="nav-group-empty">Empty group</div>
            )}
          </div>
        ))}
        {!props.workspaces.length ? (
          <div className="empty compact">No workspaces yet. Use the plus button above to create one.</div>
        ) : null}
      </div>
      {showAddRepo ? <AddRepoModal onClose={() => setShowAddRepo(false)} /> : null}
      {showCreateWorkspace ? (
        <CreateWorkspaceModal
          repos={props.repos}
          {...(props.lastRepoId ? { lastRepoId: props.lastRepoId } : {})}
          runtimes={props.runtimes}
          onClose={() => setShowCreateWorkspace(false)}
          onCreated={(workspaceId) => {
            setShowCreateWorkspace(false);
            const created = props.workspaces.find((workspace) => workspace.id === workspaceId);
            if (created) props.onPickWorkspace(created);
          }}
        />
      ) : null}
    </>
  );
}

type GroupedSection = {
  id: string;
  label: string;
  workspaces: Array<{ workspace: Workspace; sessions: AgentSession[] }>;
};

function buildGroups(
  workspaces: Workspace[],
  repos: Repo[],
  sessions: AgentSession[],
  operations: Operation[],
  activeSummary: WorkspaceCockpitSummary | undefined,
  grouping: GroupKey[],
): GroupedSection[] {
  if (!grouping.length) {
    return [
      {
        id: "all",
        label: "",
        workspaces: workspaces.map((workspace) => ({
          workspace,
          sessions: sessions.filter((session) => session.workspaceId === workspace.id),
        })),
      },
    ];
  }
  const enriched = workspaces.map((workspace) => {
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

  const compose = (entries: typeof enriched, levels: GroupKey[]): GroupedSection[] => {
    if (!levels.length) {
      return [
        { id: "leaf", label: "", workspaces: entries.map(({ workspace, sessions }) => ({ workspace, sessions })) },
      ];
    }
    const [head, ...rest] = levels;
    const buckets = new Map<string, { label: string; items: typeof enriched }>();
    for (const entry of entries) {
      const keyValue = head === "repo" ? (entry.repo?.name ?? "Unknown repo") : formatLabel(entry.section ?? "idle");
      const bucket = buckets.get(keyValue) ?? { label: keyValue, items: [] };
      bucket.items.push(entry);
      buckets.set(keyValue, bucket);
    }
    const sortedKeys = Array.from(buckets.keys()).sort((a, b) => {
      if (head === "status") {
        const ai = SECTION_ORDER.indexOf(a.toLowerCase());
        const bi = SECTION_ORDER.indexOf(b.toLowerCase());
        return (ai < 0 ? SECTION_ORDER.length : ai) - (bi < 0 ? SECTION_ORDER.length : bi);
      }
      return a.localeCompare(b);
    });
    const result: GroupedSection[] = [];
    for (const key of sortedKeys) {
      const bucket = buckets.get(key);
      if (!bucket) continue;
      const childSections = compose(bucket.items, rest);
      if (rest.length === 0) {
        result.push({ id: key, label: bucket.label, workspaces: childSections[0]?.workspaces ?? [] });
      } else {
        for (const child of childSections) {
          result.push({
            id: `${key}::${child.id}`,
            label: child.label ? `${bucket.label} · ${child.label}` : bucket.label,
            workspaces: child.workspaces,
          });
        }
      }
    }
    return result;
  };
  return compose(enriched, grouping);
}
