import type { AgentSession, Operation, Repo, Workspace } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, FolderGit2, FolderPlus, Search, Settings as SettingsIcon, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, queryClient } from "./api.js";
import type { StateResponse } from "./app-state.js";
import { useOverlayPresent } from "./use-overlay-present.js";

type RepoInspectResult = {
  rootPath: string;
  exists: boolean;
  isGit: boolean;
  defaultBranch: string | null;
  remotes: string[];
  suggestedWorktreeParent: string;
};

export function RepositoriesPanel(props: { state: StateResponse | undefined }) {
  const [query, setQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);

  const repos = props.state?.repos ?? [];
  const workspaces = props.state?.workspaces ?? [];
  const sessions = props.state?.sessions ?? [];
  const operations = props.state?.operations ?? [];

  const filtered = repos.filter(
    (repo) =>
      !query ||
      repo.name.toLowerCase().includes(query.toLowerCase()) ||
      repo.rootPath.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <>
      <div className="set-repo-toolbar">
        <div className="set-repo-search">
          <Search size={13} />
          <input
            type="text"
            className="set-repo-search-input"
            placeholder="Search repositories by name or path…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            spellCheck={false}
          />
          {query ? (
            <button type="button" className="set-repo-search-clear" onClick={() => setQuery("")} title="Clear">
              ×
            </button>
          ) : null}
        </div>
        <button type="button" className="set-btn set-btn-primary" onClick={() => setShowAdd(true)}>
          <FolderPlus size={13} /> Add repository
        </button>
      </div>

      <div className="set-section-head" style={{ padding: "4px 4px 8px" }}>
        <span className="set-section-eyebrow">Tracked repositories</span>
        <span className="set-section-count">
          {filtered.length}
          {filtered.length !== repos.length ? ` / ${repos.length}` : ""}
        </span>
      </div>

      {repos.length === 0 ? (
        <div className="set-empty">
          <div className="set-empty-icon">
            <FolderGit2 size={28} />
          </div>
          <div className="set-empty-title">No repositories registered</div>
          <div className="set-empty-sub">
            Register a local git repository to let Citadel manage worktrees, sessions, and operations against it.
          </div>
          <button type="button" className="set-btn set-btn-primary" onClick={() => setShowAdd(true)}>
            <FolderPlus size={13} /> Add repository
          </button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="set-empty" style={{ padding: "32px 24px" }}>
          <div className="set-empty-title" style={{ fontSize: 16 }}>
            No repositories match “{query}”
          </div>
          <button type="button" className="set-btn set-btn-ghost" onClick={() => setQuery("")}>
            Clear search
          </button>
        </div>
      ) : (
        <div className="set-repo-cards">
          {filtered.map((repo) => (
            <RepoCard
              key={repo.id}
              repo={repo}
              workspaces={workspaces.filter((workspace) => workspace.repoId === repo.id)}
              sessions={sessions}
              operations={operations}
            />
          ))}
        </div>
      )}

      {showAdd ? <AddRepoModal onClose={() => setShowAdd(false)} /> : null}
    </>
  );
}

function RepoCard(props: {
  repo: Repo;
  workspaces: Workspace[];
  sessions: AgentSession[];
  operations: Operation[];
}) {
  const [confirming, setConfirming] = useState(false);
  const workspaceIds = new Set(props.workspaces.map((workspace) => workspace.id));
  const activeSessions = props.sessions.filter(
    (session) =>
      workspaceIds.has(session.workspaceId) && ["starting", "running", "waiting_for_input"].includes(session.status),
  ).length;
  const runningOperations = props.operations.filter(
    (operation) => operation.repoId === props.repo.id && ["queued", "running"].includes(operation.status),
  ).length;
  const remove = useMutation({
    mutationFn: () => api(`/api/repos/${props.repo.id}${confirming ? "?force=true" : ""}`, { method: "DELETE" }),
    onSuccess: () => {
      setConfirming(false);
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
    onError: () => setConfirming(true),
  });
  const needsConfirmation = activeSessions > 0 || runningOperations > 0;
  return (
    <div className="set-repo-card">
      <div className="set-repo-card-head">
        <div className="set-repo-name-block">
          <span className="set-repo-name">{props.repo.name}</span>
          <span className="set-repo-path">{props.repo.rootPath}</span>
        </div>
        <div className="set-repo-actions">
          <Link to="/" className="set-btn set-btn-sm" title="Open in cockpit">
            <ExternalLink size={11} /> Open
          </Link>
          <Link to="/repos/$repoId" params={{ repoId: props.repo.id }} className="set-btn set-btn-sm">
            <SettingsIcon size={11} /> Repo settings
          </Link>
        </div>
      </div>
      <div className="set-repo-stats">
        <div className="set-repo-stat">
          <div className="set-repo-stat-num">{props.workspaces.length}</div>
          <div className="set-repo-stat-label">workspaces</div>
        </div>
        <div className="set-repo-stat">
          <div className={`set-repo-stat-num ${activeSessions > 0 ? "is-warn" : ""}`}>{activeSessions}</div>
          <div className="set-repo-stat-label">active sessions</div>
        </div>
        <div className="set-repo-stat">
          <div className={`set-repo-stat-num ${runningOperations > 0 ? "is-warn" : ""}`}>{runningOperations}</div>
          <div className="set-repo-stat-label">running ops</div>
        </div>
        <div className="set-repo-stat-right">
          <div className="set-repo-stat-line">
            on <span className="set-mono">{props.repo.defaultBranch}</span>
          </div>
          <div className="set-repo-stat-line">
            worktree parent: <span className="set-mono">{props.repo.worktreeParent}</span>
          </div>
        </div>
      </div>
      <div className="set-repo-card-foot">
        {confirming || (needsConfirmation && remove.isError) ? (
          <span style={{ fontSize: 11, color: "var(--c-fg-3)" }}>
            Removal preserves local repos/worktrees. Confirm to forget tracking.
          </span>
        ) : null}
        <button
          type="button"
          className={`set-btn set-btn-danger set-btn-sm ${confirming ? "" : ""}`}
          style={{ marginLeft: "auto" }}
          onClick={() => remove.mutate()}
          disabled={remove.isPending}
        >
          <Trash2 size={11} /> {confirming ? "Confirm remove" : "Remove tracking"}
        </button>
      </div>
    </div>
  );
}

function AddRepoModal(props: { onClose: () => void }) {
  useOverlayPresent();
  const [rootPath, setRootPath] = useState("");
  const [name, setName] = useState("");
  const pathRef = useRef<HTMLInputElement>(null);
  const inspect = useMutation({
    mutationFn: () =>
      api<RepoInspectResult>("/api/repos/inspect", { method: "POST", body: JSON.stringify({ rootPath }) }),
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
      queryClient.invalidateQueries({ queryKey: ["state"] });
      props.onClose();
    },
  });

  useEffect(() => {
    pathRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [props.onClose]);

  const inspected = inspect.data && inspect.data.rootPath === rootPath ? inspect.data : null;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!inspected) {
      inspect.mutate();
      return;
    }
    if (inspected.isGit) register.mutate();
  };

  return (
    <div className="set-modal-scrim" role="presentation" onMouseDown={props.onClose}>
      <div className="set-modal" onMouseDown={(event) => event.stopPropagation()}>
        <div className="set-modal-head">
          <div>
            <div className="set-modal-eyebrow">Repositories</div>
            <div className="set-modal-title">Add repository</div>
          </div>
          <button type="button" className="set-icon-btn" onClick={props.onClose} title="Close (Esc)">
            ×
          </button>
        </div>

        <form onSubmit={submit}>
          <div className="set-modal-body">
            <label className="set-modal-field">
              <span className="set-field-label">Path</span>
              <input
                ref={pathRef}
                className="set-input is-mono"
                placeholder="/home/me/project"
                value={rootPath}
                onChange={(event) => {
                  setRootPath(event.target.value);
                  inspect.reset();
                }}
              />
            </label>
            <label className="set-modal-field">
              <span className="set-field-label">
                Display name <span className="set-field-opt">(optional)</span>
              </span>
              <input
                className="set-input"
                placeholder="inferred from folder name"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <div className="set-modal-hint">
              Citadel will scan the path, register the git remote, and add it to your tracked list. Nothing on disk is
              moved.
            </div>
            {inspected ? (
              <div className="set-modal-hint">
                {inspected.isGit ? (
                  <>
                    Default branch: <span className="set-mono">{inspected.defaultBranch ?? "?"}</span>
                    <br />
                    Remotes: <span className="set-mono">{inspected.remotes.join(", ") || "(none)"}</span>
                    <br />
                    Worktree parent: <span className="set-mono">{inspected.suggestedWorktreeParent}</span>
                  </>
                ) : (
                  <span style={{ color: "var(--c-bad)" }}>
                    {inspected.exists ? "Not a git repository" : "Path does not exist"}
                  </span>
                )}
              </div>
            ) : null}
            {inspect.error ? <span className="form-error">{String(inspect.error)}</span> : null}
            {register.error ? <span className="form-error">{String(register.error)}</span> : null}
          </div>

          <div className="set-modal-foot">
            <button type="button" className="set-btn set-btn-ghost" onClick={props.onClose}>
              Cancel
            </button>
            <button
              type="submit"
              className="set-btn set-btn-primary"
              disabled={!rootPath || inspect.isPending || register.isPending}
            >
              <FolderPlus size={13} /> {inspected ? (inspected.isGit ? "Register" : "Inspect") : "Inspect & add"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
