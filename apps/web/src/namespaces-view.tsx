import type { Namespace, Workspace } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Archive, Check, FolderPlus, Pencil, X } from "lucide-react";
import { useMemo, useState } from "react";
import { api, queryClient } from "./api.js";
import type { StateResponse } from "./app-state.js";
import { Button } from "./components/ui/button.js";
import { WorkspaceCard } from "./workspace-card.js";

export function NamespacesView(props: { data: StateResponse | undefined }) {
  const data = props.data;
  const navigate = useNavigate();
  const [draftName, setDraftName] = useState("");
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const create = useMutation({
    mutationFn: (name: string) =>
      api<{ namespace: Namespace }>("/api/namespaces", {
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["state"] }),
  });

  const groups = useMemo(() => buildGroups(data?.workspaces ?? [], data?.namespaces ?? []), [data]);

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
      </div>
      <div className="namespaces-grid">
        {groups.map((group) => (
          <section key={group.key} className="namespace-card">
            <header className="namespace-card-header">
              {editing && group.namespace && editing.id === group.namespace.id ? (
                <div className="namespace-card-edit">
                  <input
                    ref={(node) => node?.focus()}
                    value={editing.name}
                    onChange={(event) =>
                      setEditing((current) => (current ? { id: current.id, name: event.target.value } : current))
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && editing.name.trim()) rename.mutate(editing);
                      else if (event.key === "Escape") setEditing(null);
                    }}
                  />
                  <Button type="button" size="icon" variant="ghost" onClick={() => rename.mutate(editing)}>
                    <Check size={12} />
                  </Button>
                  <Button type="button" size="icon" variant="ghost" onClick={() => setEditing(null)}>
                    <X size={12} />
                  </Button>
                </div>
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
                        onClick={() => group.namespace && archive.mutate(group.namespace.id)}
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
                      active={false}
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
    </div>
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
