import type { AgentSession, Operation, Repo, Workspace } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, Folder, FolderGit2, FolderPlus, Search, Settings as SettingsIcon, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, queryClient } from "./api.js";
import type { StateResponse } from "./app-state.js";

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
      workspaceIds.has(session.workspaceId) &&
      ["starting", "running", "waiting_for_input", "rate_limited", "usage_limited"].includes(session.status),
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

type PathCompletionEntry = { name: string; path: string; isGit: boolean };
type PathCompletionResponse = { baseDir: string; filter: string; entries: PathCompletionEntry[] };

function PathAutocomplete(props: {
  value: string;
  onChange: (next: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  placeholder?: string;
}) {
  const [entries, setEntries] = useState<PathCompletionEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(-1);
  const inputRef = props.inputRef;
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      const prefix = props.value;
      api<PathCompletionResponse>(`/api/fs/complete?prefix=${encodeURIComponent(prefix)}`)
        .then((data) => {
          if (cancelled) return;
          setEntries(data.entries);
          setFocused(-1);
        })
        .catch(() => {
          if (cancelled) return;
          setEntries([]);
        });
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [props.value]);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [open]);

  const acceptEntry = (entry: PathCompletionEntry) => {
    props.onChange(`${entry.path}/`);
    setFocused(-1);
    setOpen(true);
    inputRef?.current?.focus();
  };

  return (
    <div className="set-path-autocomplete" ref={containerRef}>
      <input
        ref={inputRef}
        className="set-input is-mono"
        placeholder={props.placeholder}
        value={props.value}
        autoComplete="off"
        spellCheck={false}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          props.onChange(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (!entries.length) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
            setFocused((current) => Math.min(current + 1, entries.length - 1));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setFocused((current) => Math.max(current - 1, -1));
          } else if (event.key === "Tab" && open) {
            const target = focused >= 0 ? entries[focused] : entries[0];
            if (target) {
              event.preventDefault();
              acceptEntry(target);
            }
          } else if (event.key === "Enter" && open && focused >= 0) {
            const target = entries[focused];
            if (target) {
              event.preventDefault();
              acceptEntry(target);
            }
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
        }}
      />
      {open && entries.length ? (
        <div className="set-path-suggestions">
          {entries.map((entry, index) => (
            <button
              key={entry.path}
              type="button"
              tabIndex={-1}
              aria-selected={focused === index}
              className={`set-path-suggestion ${focused === index ? "is-focused" : ""}`}
              onMouseEnter={() => setFocused(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                acceptEntry(entry);
              }}
            >
              {entry.isGit ? <FolderGit2 size={13} /> : <Folder size={13} />}
              <span className="set-path-suggestion-name">{entry.name}</span>
              {entry.isGit ? <span className="set-path-suggestion-tag">git</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AddRepoModal(props: { onClose: () => void }) {
  const [rootPath, setRootPath] = useState("");
  const [name, setName] = useState("");
  const pathRef = useRef<HTMLInputElement>(null);
  const inspect = useMutation({
    mutationFn: () =>
      api<RepoInspectResult>("/api/repos/inspect", { method: "POST", body: JSON.stringify({ rootPath }) }),
    onSuccess: (data) => {
      // Snap input to the resolved path so the inspected-state comparison below
      // is always exact (otherwise trailing slashes, ~/, or relative paths leave
      // the form stuck on the "Inspect" label and the Register button never fires).
      if (data.rootPath !== rootPath) setRootPath(data.rootPath);
    },
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
            <div className="set-modal-field">
              <span className="set-field-label">Path</span>
              <PathAutocomplete
                inputRef={pathRef}
                value={rootPath}
                placeholder="~/projects/my-repo"
                onChange={(next) => {
                  setRootPath(next);
                  inspect.reset();
                }}
              />
            </div>
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
