import type { AgentSession, Operation, Repo, Workspace } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { api, queryClient } from "./api.js";
import type { StateResponse } from "./app-state.js";
import { Button } from "./components/ui/button.js";

export function RepositoriesPanel(props: { state: StateResponse | undefined }) {
  if (!props.state?.repos.length) {
    return (
      <div className="settings-stack">
        <div className="empty">No repositories registered.</div>
        <Link to="/onboarding" className="settings-link">
          Open onboarding to register your first repo
        </Link>
      </div>
    );
  }
  return (
    <div className="settings-stack">
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
      ["starting", "running", "waiting", "idle"].includes(session.status),
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
