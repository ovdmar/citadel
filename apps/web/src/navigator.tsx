import type { AgentSession, Namespace, Operation, Repo, Workspace, WorkspaceCockpitSummary } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import {
  Check,
  ClipboardList,
  FolderPlus,
  LayoutDashboard,
  NotebookPen,
  PanelLeftClose,
  Plus,
  Settings2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, queryClient } from "./api.js";
import { readinessForWorkspace } from "./cockpit-readiness.js";
import { formatLabel } from "./labels.js";
import { AddRepoModal, CreateWorkspaceModal, GroupByOverlay, type GroupKey, normalizeGrouping } from "./modals.js";
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
  const [grouping, setGroupingRaw] = useState<GroupKey[]>(() => {
    if (typeof window === "undefined") return ["repo", "status"];
    try {
      const raw = window.localStorage.getItem(GROUP_STORAGE);
      if (!raw) return ["repo", "status"];
      const parsed = JSON.parse(raw) as GroupKey[];
      const allowed = parsed.filter(
        (entry): entry is GroupKey => entry === "repo" || entry === "status" || entry === "namespace",
      );
      return normalizeGrouping(allowed.length ? allowed : ["repo", "status"]);
    } catch {
      return ["repo", "status"];
    }
  });
  // Wrap setGrouping so any call site (overlay edits, future code) lands on a
  // normalized value. Namespace-without-repo would produce ambiguous groups.
  const setGrouping = (next: GroupKey[] | ((prev: GroupKey[]) => GroupKey[])) => {
    setGroupingRaw((prev) => normalizeGrouping(typeof next === "function" ? next(prev) : next));
  };
  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(GROUP_STORAGE, JSON.stringify(grouping));
  }, [grouping]);

  const [showGroupBy, setShowGroupBy] = useState(false);
  const [showAddRepo, setShowAddRepo] = useState(false);

  // Intentionally exclude props.activeSummary from buildGroups: status sections
  // are derived from /api/state only, so the active workspace doesn't drift
  // between sections each time the per-workspace cockpit-summary refetches.
  const grouped = useMemo(
    () => buildGroups(props.workspaces, props.repos, props.sessions, props.operations, props.namespaces, grouping),
    [props.workspaces, props.repos, props.sessions, props.operations, props.namespaces, grouping],
  );
  const emptyNamespaceGroups = useMemo(
    () => emptyNamespaceSections(props.namespaces, props.workspaces, grouping),
    [props.namespaces, props.workspaces, grouping],
  );
  const groupingHasNamespace = grouping.includes("namespace");
  const namespacesById = useMemo(() => {
    const map = new Map<string, import("@citadel/contracts").Namespace>();
    for (const namespace of props.namespaces) map.set(namespace.id, namespace);
    return map;
  }, [props.namespaces]);
  const [editingNamespaceId, setEditingNamespaceId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const createNamespace = useMutation({
    mutationFn: (name: string) =>
      api<{ namespace: Namespace; created: boolean }>("/api/namespaces", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      // Immediately enter rename mode so the user can swap the placeholder for
      // a real name without clicking around.
      setEditingNamespaceId(result.namespace.id);
    },
  });

  const renameNamespace = useMutation({
    mutationFn: (patch: { id: string; name: string }) =>
      api<{ namespace: Namespace }>(`/api/namespaces/${patch.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: patch.name }),
      }),
    onSuccess: () => {
      setEditingNamespaceId(null);
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  const assignNamespace = useMutation({
    mutationFn: (input: { workspaceId: string; namespaceId: string | null }) =>
      api("/api/namespaces/assign", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const dropOnNamespace = (event: React.DragEvent, namespaceId: string | null) => {
    event.preventDefault();
    setDropTargetId(null);
    const workspaceId = event.dataTransfer.getData("application/x-citadel-workspace-id");
    if (!workspaceId) return;
    const workspace = props.workspaces.find((entry) => entry.id === workspaceId);
    // No-op when the workspace already lives in this namespace.
    if (!workspace || workspace.namespaceId === namespaceId) return;
    assignNamespace.mutate({ workspaceId, namespaceId });
  };

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
          {[...grouped, ...emptyNamespaceGroups].map((section) => {
            const isNamespaceTarget = section.namespaceId !== undefined && groupingHasNamespace;
            const isDropHover = dropTargetId === section.id;
            const renaming = section.namespaceId && editingNamespaceId === section.namespaceId;
            return (
              <div
                key={section.id}
                className={`nav-group ${isDropHover ? "drop-hover" : ""}`}
                {...(isNamespaceTarget
                  ? {
                      onDragOver: (event: React.DragEvent) => {
                        if (event.dataTransfer.types.includes("application/x-citadel-workspace-id")) {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "move";
                          setDropTargetId(section.id);
                        }
                      },
                      onDragLeave: () => setDropTargetId((current) => (current === section.id ? null : current)),
                      onDrop: (event: React.DragEvent) => dropOnNamespace(event, section.namespaceId ?? null),
                    }
                  : {})}
              >
                {renaming && section.namespaceId ? (
                  <NamespaceRenameInput
                    initial={section.label}
                    onSave={(value) => renameNamespace.mutate({ id: section.namespaceId as string, name: value })}
                    onCancel={() => setEditingNamespaceId(null)}
                  />
                ) : section.label ? (
                  <div className="nav-group-header">
                    <span>{section.label}</span>
                    {section.namespaceId ? (
                      <button
                        type="button"
                        className="nav-group-header-edit"
                        onClick={() => setEditingNamespaceId(section.namespaceId as string)}
                        aria-label={`Rename namespace ${section.label}`}
                        title="Rename namespace"
                      >
                        <Plus size={10} style={{ transform: "rotate(45deg)" }} />
                      </button>
                    ) : null}
                  </div>
                ) : null}
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
                      namespace={workspace.namespaceId ? (namespacesById.get(workspace.namespaceId) ?? null) : null}
                      namespaces={props.namespaces}
                      active={workspace.id === props.activeWorkspaceId}
                      draggable={groupingHasNamespace}
                      onSelect={() => props.onPickWorkspace(workspace)}
                    />
                  ))
                ) : (
                  <div className="nav-group-empty">{isNamespaceTarget ? "Drop a workspace here" : "Empty group"}</div>
                )}
              </div>
            );
          })}
          {groupingHasNamespace ? (
            <button
              type="button"
              className="nav-new-namespace"
              onClick={() => createNamespace.mutate(`untitled-${Date.now().toString(36).slice(-5)}`)}
              disabled={createNamespace.isPending}
              title="Create a new namespace"
            >
              <Plus size={11} /> New namespace
            </button>
          ) : null}
          {!props.workspaces.length && !emptyNamespaceGroups.length ? (
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

function NamespaceRenameInput(props: { initial: string; onSave: (next: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(props.initial);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div className="nav-group-rename">
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && value.trim()) props.onSave(value.trim());
          else if (event.key === "Escape") props.onCancel();
        }}
        aria-label="Namespace name"
      />
      <button
        type="button"
        onClick={() => value.trim() && props.onSave(value.trim())}
        aria-label="Save name"
        title="Save"
      >
        <Check size={11} />
      </button>
      <button type="button" onClick={props.onCancel} aria-label="Cancel rename" title="Cancel">
        <X size={11} />
      </button>
    </div>
  );
}

type GroupedSection = {
  id: string;
  label: string;
  // Carried for namespace drop targets and rename mode. `null` means the
  // bucket represents "no namespace assigned" (the Uncategorized section).
  // `undefined` means this section isn't keyed by namespace at all.
  namespaceId?: string | null;
  workspaces: Array<{ workspace: Workspace; sessions: AgentSession[] }>;
};

function buildGroups(
  workspaces: Workspace[],
  repos: Repo[],
  sessions: AgentSession[],
  operations: Operation[],
  namespaces: Namespace[],
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
    const attention = readinessForWorkspace(workspace, {
      sessions: workspaceSessions,
      operations: workspaceOps,
    });
    const repo = repos.find((entry) => entry.id === workspace.repoId);
    const namespace = workspace.namespaceId
      ? (namespaces.find((entry) => entry.id === workspace.namespaceId) ?? null)
      : null;
    return { workspace, sessions: workspaceSessions, repo, namespace, section: attention.section };
  });

  const compose = (entries: typeof enriched, levels: GroupKey[]): GroupedSection[] => {
    if (!levels.length) {
      return [
        { id: "leaf", label: "", workspaces: entries.map(({ workspace, sessions }) => ({ workspace, sessions })) },
      ];
    }
    const [head, ...rest] = levels;
    type Bucket = { label: string; items: typeof enriched; namespaceId?: string | null };
    const buckets = new Map<string, Bucket>();
    for (const entry of entries) {
      let keyValue: string;
      let namespaceId: string | null | undefined;
      if (head === "repo") keyValue = entry.repo?.name ?? "Unknown repo";
      else if (head === "namespace") {
        keyValue = entry.namespace?.name ?? "Uncategorized";
        namespaceId = entry.namespace?.id ?? null;
      } else keyValue = formatLabel(entry.section ?? "idle");
      let bucket = buckets.get(keyValue);
      if (!bucket) {
        const fresh: Bucket = { label: keyValue, items: [] };
        if (namespaceId !== undefined) fresh.namespaceId = namespaceId;
        bucket = fresh;
        buckets.set(keyValue, bucket);
      }
      bucket.items.push(entry);
    }
    const sortedKeys = Array.from(buckets.keys()).sort((a, b) => {
      if (head === "status") {
        const ai = SECTION_ORDER.indexOf(a.toLowerCase());
        const bi = SECTION_ORDER.indexOf(b.toLowerCase());
        return (ai < 0 ? SECTION_ORDER.length : ai) - (bi < 0 ? SECTION_ORDER.length : bi);
      }
      if (head === "namespace") {
        if (a === "Uncategorized") return 1;
        if (b === "Uncategorized") return -1;
        return a.localeCompare(b);
      }
      return a.localeCompare(b);
    });
    const result: GroupedSection[] = [];
    for (const key of sortedKeys) {
      const bucket = buckets.get(key);
      if (!bucket) continue;
      const childSections = compose(bucket.items, rest);
      if (rest.length === 0) {
        const section: GroupedSection = {
          id: key,
          label: bucket.label,
          workspaces: childSections[0]?.workspaces ?? [],
        };
        if (bucket.namespaceId !== undefined) section.namespaceId = bucket.namespaceId;
        result.push(section);
      } else {
        for (const child of childSections) {
          const section: GroupedSection = {
            id: `${key}::${child.id}`,
            label: child.label ? `${bucket.label} · ${child.label}` : bucket.label,
            workspaces: child.workspaces,
          };
          // Inherit namespaceId from whichever level set it.
          const ns = child.namespaceId !== undefined ? child.namespaceId : bucket.namespaceId;
          if (ns !== undefined) section.namespaceId = ns;
          result.push(section);
        }
      }
    }
    return result;
  };
  return compose(enriched, grouping);
}

// When grouping by namespace, surface namespaces that have no workspaces yet
// so the user can rename a freshly created one (or drag workspaces into it).
// Pinned at the bottom of the rendered group list.
function emptyNamespaceSections(
  namespaces: Namespace[],
  workspaces: Workspace[],
  grouping: GroupKey[],
): GroupedSection[] {
  if (!grouping.includes("namespace")) return [];
  const occupied = new Set<string>();
  for (const workspace of workspaces) {
    if (workspace.namespaceId) occupied.add(workspace.namespaceId);
  }
  return namespaces
    .filter((namespace) => !occupied.has(namespace.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map<GroupedSection>((namespace) => ({
      id: `__empty_ns__${namespace.id}`,
      label: namespace.name,
      namespaceId: namespace.id,
      workspaces: [],
    }));
}
