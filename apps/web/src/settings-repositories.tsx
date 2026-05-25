import type { AgentSession, Operation, Repo, Workspace } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FolderPlus, Trash2 } from "lucide-react";
import { useState } from "react";
import { api, queryClient } from "./api.js";
import type { StateResponse } from "./app-state.js";
import { Button } from "./components/ui/button.js";

type RepoInspectResult = {
  rootPath: string;
  exists: boolean;
  isGit: boolean;
  defaultBranch: string | null;
  remotes: string[];
  suggestedWorktreeParent: string;
};

export function RepositoriesPanel(props: { state: StateResponse | undefined }) {
  if (!props.state?.repos.length) {
    return (
      <div className="settings-stack">
        <AddRepositoryCard />
        <div className="empty">No repositories registered.</div>
      </div>
    );
  }
  return (
    <div className="settings-stack">
      <AddRepositoryCard />
      <p className="settings-hint">
        Repositories Citadel tracks. Removing tracking preserves the working copy and worktrees on disk.
      </p>
      <div className="repo-management">
        {props.state.repos.map((repo) => (
          <RepositoryRow
            key={repo.id}
            repo={repo}
            workspaces={props.state?.workspaces.filter((workspace) => workspace.repoId === repo.id) ?? []}
            sessions={props.state?.sessions ?? []}
            operations={props.state?.operations ?? []}
          />
        ))}
      </div>
    </div>
  );
}

function AddRepositoryCard() {
  const [rootPath, setRootPath] = useState("");
  const [name, setName] = useState("");
  const inspect = useMutation({
    mutationFn: () =>
      api<RepoInspectResult>("/api/repos/inspect", {
        method: "POST",
        body: JSON.stringify({ rootPath }),
      }),
  });
  const register = useMutation({
    mutationFn: () =>
      api("/api/repos", {
        method: "POST",
        body: JSON.stringify({
          rootPath,
          name: name || undefined,
          worktreeParent: inspect.data?.suggestedWorktreeParent,
        }),
      }),
    onSuccess: () => {
      setRootPath("");
      setName("");
      inspect.reset();
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });
  return (
    <section className="settings-card">
      <header className="settings-card-header">
        <h3>Add repository</h3>
        <p>Register a local git repository here. Repo hook bindings stay in each repository's settings page.</p>
      </header>
      <form
        className="repo-add-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!inspect.data || inspect.data.rootPath !== rootPath) {
            inspect.mutate();
            return;
          }
          if (inspect.data.isGit) register.mutate();
        }}
      >
        <input
          value={rootPath}
          onChange={(event) => {
            setRootPath(event.target.value);
            inspect.reset();
          }}
          placeholder="/home/me/project"
          aria-label="Repository path"
        />
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Display name" />
        <Button type="submit" disabled={!rootPath || inspect.isPending || register.isPending}>
          <FolderPlus size={14} /> {!inspect.data || inspect.data.rootPath !== rootPath ? "Inspect" : "Register"}
        </Button>
      </form>
      {inspect.data ? (
        <div className={`repo-inspect ${inspect.data.isGit ? "ok" : "warn"}`}>
          {inspect.data.isGit ? (
            <>
              <small>Default branch: {inspect.data.defaultBranch ?? "?"}</small>
              <small>Remotes: {inspect.data.remotes.join(", ") || "(none)"}</small>
              <small>Worktree parent: {inspect.data.suggestedWorktreeParent}</small>
            </>
          ) : (
            <small>{inspect.data.exists ? "Not a git repository" : "Path does not exist"}</small>
          )}
        </div>
      ) : null}
      {inspect.error ? <p className="form-error">{String(inspect.error)}</p> : null}
      {register.error ? <p className="form-error">{String(register.error)}</p> : null}
    </section>
  );
}

function RepositoryRow(props: {
  repo: Repo;
  workspaces: Workspace[];
  sessions: AgentSession[];
  operations: Operation[];
}) {
  const [confirming, setConfirming] = useState(false);
  const activeSessions = props.sessions.filter(
    (session) =>
      props.workspaces.some((workspace) => workspace.id === session.workspaceId) &&
      ["starting", "running", "waiting_for_input"].includes(session.status),
  ).length;
  const runningOperations = props.operations.filter(
    (operation) => operation.repoId === props.repo.id && ["queued", "running"].includes(operation.status),
  ).length;
  const remove = useMutation({
    mutationFn: () =>
      api(`/api/repos/${props.repo.id}${confirming ? "?force=true" : ""}`, {
        method: "DELETE",
      }),
    onSuccess: () => {
      setConfirming(false);
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: () => setConfirming(true),
  });
  const needsConfirmation = activeSessions > 0 || runningOperations > 0;
  return (
    <div className="repo-row">
      <div>
        <strong>{props.repo.name}</strong>
        <span>{props.repo.rootPath}</span>
        <small>
          {props.workspaces.length} workspaces - {activeSessions} active sessions - {runningOperations} running
          operations
        </small>
      </div>
      <div className="repo-remove-controls">
        {confirming || needsConfirmation ? (
          <small>Removal preserves local repos/worktrees. Confirm when active work exists.</small>
        ) : null}
        <Link
          to="/repos/$repoId"
          params={{ repoId: props.repo.id }}
          className="settings-link"
          aria-label={`Open settings for ${props.repo.name}`}
        >
          Repo settings
        </Link>
        <Button
          type="button"
          className={confirming ? "danger-action" : undefined}
          variant={confirming ? "default" : "secondary"}
          onClick={() => remove.mutate()}
        >
          <Trash2 size={14} />
          {confirming ? "Confirm remove" : "Remove tracking"}
        </Button>
      </div>
    </div>
  );
}
