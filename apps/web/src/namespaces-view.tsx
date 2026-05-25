import type { Namespace, Workspace } from "@citadel/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Check, FolderPlus, Pencil, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, queryClient } from "./api.js";
import type { StateResponse } from "./app-state.js";
import { Button } from "./components/ui/button.js";
import { WorkspaceCard } from "./workspace-card.js";

export function NamespacesView(props: { data: StateResponse | undefined }) {
  const data = props.data;
  const navigate = useNavigate();
  const [draftName, setDraftName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Namespace | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const create = useMutation({
    mutationFn: (name: string) =>
      api<{ namespace: Namespace; created: boolean }>("/api/namespaces", {
        method: "POST",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      setDraftName("");
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  const rename = useMutation({
    mutationFn: (patch: { id: string; name: string }) =>
      api<{ namespace: Namespace }>(`/api/namespaces/${patch.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: patch.name }),
      }),
    onSuccess: () => {
      setEditing(null);
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  const archive = useMutation({
    mutationFn: (id: string) => api(`/api/namespaces/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setArchiveTarget(null);
      queryClient.invalidateQueries({ queryKey: ["state"] });
      queryClient.invalidateQueries({ queryKey: ["namespaces", "archived"] });
    },
  });

  const assign = useMutation({
    mutationFn: (input: { workspaceId: string; namespaceId: string | null }) =>
      api("/api/namespaces/assign", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);
  const handleDrop = (event: React.DragEvent, namespaceId: string | null) => {
    event.preventDefault();
    setDropTargetKey(null);
    const workspaceId = event.dataTransfer.getData("application/x-citadel-workspace-id");
    if (!workspaceId) return;
    const workspace = data?.workspaces.find((entry) => entry.id === workspaceId);
    if (!workspace || workspace.namespaceId === namespaceId) return;
    assign.mutate({ workspaceId, namespaceId });
  };

  const restore = useMutation({
    mutationFn: (id: string) => api(`/api/namespaces/${id}/restore`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      queryClient.invalidateQueries({ queryKey: ["namespaces", "archived"] });
    },
  });

  const archivedQuery = useQuery({
    queryKey: ["namespaces", "archived"],
    queryFn: () =>
      api<{ namespaces: Namespace[] }>("/api/namespaces?includeArchived=true").then((response) =>
        response.namespaces.filter((entry) => entry.archivedAt),
      ),
    enabled: showArchived,
  });

  const groups = useMemo(() => buildGroups(data?.workspaces ?? [], data?.namespaces ?? []), [data]);
  const namespacesById = useMemo(() => {
    const map = new Map<string, Namespace>();
    for (const namespace of data?.namespaces ?? []) map.set(namespace.id, namespace);
    return map;
  }, [data?.namespaces]);

  return (
    <div className="namespaces-view">
      <div className="namespaces-toolbar">
        <FolderPlus size={14} />
        <input
          aria-label="New namespace name"
          placeholder="New namespace (e.g. epic / topic)"
          value={draftName}
          onChange={(event) => setDraftName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && draftName.trim()) create.mutate(draftName.trim());
          }}
        />
        <Button
          type="button"
          disabled={!draftName.trim() || create.isPending}
          onClick={() => create.mutate(draftName.trim())}
        >
          Create
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => setShowArchived((current) => !current)}
          aria-pressed={showArchived}
          title={showArchived ? "Hide archived namespaces" : "Show archived namespaces"}
        >
          {showArchived ? "Hide archived" : "Show archived"}
        </Button>
      </div>
      <div className="namespaces-grid">
        {groups.map((group) => (
          <section
            key={group.key}
            className={`namespace-card ${dropTargetKey === group.key ? "drop-hover" : ""}`}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes("application/x-citadel-workspace-id")) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropTargetKey(group.key);
              }
            }}
            onDragLeave={() => setDropTargetKey((current) => (current === group.key ? null : current))}
            onDrop={(event) => handleDrop(event, group.namespace?.id ?? null)}
          >
            <header className="namespace-card-header">
              {editing && group.namespace && editing.id === group.namespace.id ? (
                <RenameInput
                  initial={editing.name}
                  onCancel={() => setEditing(null)}
                  onSave={(value) => {
                    if (editing) rename.mutate({ id: editing.id, name: value });
                  }}
                />
              ) : (
                <>
                  <strong>{group.label}</strong>
                  <span className="namespace-card-count">{group.workspaces.length}</span>
                  {group.namespace ? (
                    <span className="namespace-card-actions">
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        title="Rename namespace"
                        onClick={() =>
                          group.namespace && setEditing({ id: group.namespace.id, name: group.namespace.name })
                        }
                      >
                        <Pencil size={11} />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        title="Archive namespace"
                        onClick={() => group.namespace && setArchiveTarget(group.namespace)}
                      >
                        <Archive size={11} />
                      </Button>
                    </span>
                  ) : null}
                </>
              )}
            </header>
            <div className="namespace-card-body">
              {group.workspaces.length ? (
                group.workspaces.map((workspace) => {
                  const sessions = data?.sessions.filter((session) => session.workspaceId === workspace.id) ?? [];
                  return (
                    <WorkspaceCard
                      key={workspace.id}
                      workspace={workspace}
                      sessions={sessions}
                      pullRequest={null}
                      namespace={workspace.namespaceId ? (namespacesById.get(workspace.namespaceId) ?? null) : null}
                      namespaces={data?.namespaces ?? []}
                      active={false}
                      draggable
                      onSelect={() =>
                        navigate({
                          to: "/",
                          search: { workspace: workspace.id } as { workspace?: string },
                        })
                      }
                    />
                  );
                })
              ) : (
                <div className="nav-group-empty">No workspaces yet.</div>
              )}
            </div>
          </section>
        ))}
      </div>
      {showArchived ? (
        <ArchivedNamespaces
          namespaces={archivedQuery.data ?? []}
          loading={archivedQuery.isLoading}
          onRestore={(id) => restore.mutate(id)}
          restoringId={restore.isPending ? (restore.variables ?? null) : null}
        />
      ) : null}
      {archiveTarget ? (
        <ConfirmArchiveDialog
          namespace={archiveTarget}
          pending={archive.isPending}
          error={archive.error instanceof Error ? archive.error.message : null}
          onConfirm={() => archive.mutate(archiveTarget.id)}
          onCancel={() => setArchiveTarget(null)}
        />
      ) : null}
    </div>
  );
}

function RenameInput(props: { initial: string; onSave: (next: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState(props.initial);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div className="namespace-card-edit">
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && value.trim()) props.onSave(value.trim());
          else if (event.key === "Escape") props.onCancel();
        }}
      />
      <Button type="button" size="icon" variant="ghost" onClick={() => value.trim() && props.onSave(value.trim())}>
        <Check size={12} />
      </Button>
      <Button type="button" size="icon" variant="ghost" onClick={props.onCancel}>
        <X size={12} />
      </Button>
    </div>
  );
}

function ConfirmArchiveDialog(props: {
  namespace: Namespace;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="drop-workspace-backdrop" onMouseDown={props.onCancel}>
      <dialog
        className="drop-workspace-dialog"
        aria-label={`Archive namespace ${props.namespace.name}`}
        open
        onMouseDown={(event) => event.stopPropagation()}
      >
        <strong>Archive "{props.namespace.name}"?</strong>
        <p>
          Workspaces currently in this namespace will be detached (moved to Uncategorized). The namespace stays
          recoverable via "Show archived".
        </p>
        {props.error ? <p className="drop-workspace-error">{props.error}</p> : null}
        <div className="drop-workspace-actions">
          <button type="button" className="drop-workspace-cancel" onClick={props.onCancel}>
            Cancel
          </button>
          <button type="button" className="drop-workspace-confirm" onClick={props.onConfirm} disabled={props.pending}>
            {props.pending ? "Archiving…" : "Archive namespace"}
          </button>
        </div>
      </dialog>
    </div>
  );
}

function ArchivedNamespaces(props: {
  namespaces: Namespace[];
  loading: boolean;
  onRestore: (id: string) => void;
  restoringId: string | null;
}) {
  return (
    <section className="namespaces-archived">
      <header className="namespaces-archived-header">
        <strong>Archived</strong>
        <span className="namespace-card-count">{props.namespaces.length}</span>
      </header>
      {props.loading ? (
        <div className="empty compact">Loading archived namespaces…</div>
      ) : props.namespaces.length ? (
        <ul className="namespaces-archived-list">
          {props.namespaces.map((namespace) => (
            <li key={namespace.id}>
              <span>{namespace.name}</span>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                title="Restore namespace"
                onClick={() => props.onRestore(namespace.id)}
                disabled={props.restoringId === namespace.id}
              >
                <ArchiveRestore size={12} />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="empty compact">No archived namespaces.</div>
      )}
    </section>
  );
}

type Group = {
  key: string;
  label: string;
  namespace: Namespace | null;
  workspaces: Workspace[];
};

function buildGroups(workspaces: Workspace[], namespaces: Namespace[]): Group[] {
  const byId = new Map<string, Group>();
  for (const namespace of namespaces) {
    byId.set(namespace.id, { key: namespace.id, label: namespace.name, namespace, workspaces: [] });
  }
  const uncategorized: Group = { key: "__uncategorized__", label: "Uncategorized", namespace: null, workspaces: [] };
  for (const workspace of workspaces) {
    const group = workspace.namespaceId ? byId.get(workspace.namespaceId) : null;
    (group ?? uncategorized).workspaces.push(workspace);
  }
  return [
    ...namespaces.map((namespace) => byId.get(namespace.id)).filter((entry): entry is Group => Boolean(entry)),
    uncategorized,
  ];
}
