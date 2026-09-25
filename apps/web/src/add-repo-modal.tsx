import { useMutation, useQuery } from "@tanstack/react-query";
import { Folder, FolderGit2, FolderPlus } from "lucide-react";
import { type FormEvent, type RefObject, useEffect, useRef, useState } from "react";
import { api, queryClient } from "./api.js";
import { Button } from "./components/ui/button.js";
import { Modal } from "./modals.js";
import { useOverlayPresent } from "./use-overlay-present.js";

type AddRepoSearchHit = {
  name: string;
  url: string;
  description?: string;
  defaultBranch?: string;
};

type RepoInspectResult = {
  rootPath: string;
  exists: boolean;
  isGit: boolean;
  defaultBranch: string | null;
  remotes: string[];
  suggestedWorktreeParent: string;
};

type PathCompletionEntry = { name: string; path: string; isGit: boolean };
type PathCompletionResponse = { baseDir: string; filter: string; entries: PathCompletionEntry[] };

type AddRepoModalProps = {
  onClose: () => void;
  workspaceRoot?: string;
};

function pathCompletionSelection(entry: Pick<PathCompletionEntry, "path" | "isGit">) {
  return {
    value: entry.isGit ? entry.path : `${entry.path}/`,
    keepOpen: !entry.isGit,
  };
}

function PathAutocomplete(props: {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  onSelectGit?: (path: string) => void;
  inputRef?: RefObject<HTMLInputElement | null>;
  placeholder?: string;
}) {
  const [entries, setEntries] = useState<PathCompletionEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(() => {
      api<PathCompletionResponse>(`/api/fs/complete?prefix=${encodeURIComponent(props.value)}`)
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
      window.clearTimeout(handle);
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
    const selection = pathCompletionSelection(entry);
    props.onChange(selection.value);
    if (entry.isGit) props.onSelectGit?.(selection.value);
    setFocused(-1);
    setOpen(selection.keepOpen);
    props.inputRef?.current?.focus();
  };

  return (
    <div className="set-path-autocomplete" ref={containerRef}>
      <input
        id={props.id}
        ref={props.inputRef}
        value={props.value}
        onChange={(event) => {
          props.onChange(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            return;
          }
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
          }
        }}
        placeholder={props.placeholder}
        autoComplete="off"
        spellCheck={false}
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

export const __testing__ = { pathCompletionSelection };

export function AddRepoModal(props: AddRepoModalProps) {
  useOverlayPresent();
  const [mode, setMode] = useState<"path" | "url" | "search">("path");
  const [path, setPath] = useState("");
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [name, setName] = useState("");
  const [worktreeParent, setWorktreeParent] = useState("");
  const [error, setError] = useState("");
  const pathInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (mode === "path") pathInputRef.current?.focus();
  }, [mode]);

  useEffect(() => {
    if (mode !== "search") {
      setDebouncedQuery("");
      return;
    }
    const handle = window.setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => window.clearTimeout(handle);
  }, [mode, query]);

  const inspect = useMutation({
    mutationFn: (targetPath: string) =>
      api<RepoInspectResult>("/api/repos/inspect", {
        method: "POST",
        body: JSON.stringify({ rootPath: targetPath }),
      }),
    onSuccess: (result) => {
      if (result.rootPath !== path) setPath(result.rootPath);
    },
    onError: (err) => setError(err instanceof Error ? err.message : "inspect_failed"),
  });

  const search = useQuery<{ results: AddRepoSearchHit[]; error?: string }>({
    queryKey: ["gh-repo-search", debouncedQuery],
    enabled: mode === "search" && debouncedQuery.length >= 2,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryFn: () =>
      api<{ results: AddRepoSearchHit[]; error?: string }>(
        `/api/integrations/github/search?q=${encodeURIComponent(debouncedQuery)}`,
      ).catch((error_) => ({ results: [], error: error_ instanceof Error ? error_.message : "search_failed" })),
  });

  const inspected = inspect.data && inspect.data.rootPath === path ? inspect.data : null;

  const register = useMutation({
    mutationFn: () =>
      api("/api/repos", {
        method: "POST",
        body: JSON.stringify({
          rootPath: path,
          name: name.trim() || undefined,
          worktreeParent: worktreeParent.trim() || undefined,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      props.onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "register_failed"),
  });

  const clone = useMutation({
    mutationFn: (target: { url: string; suggestedName?: string }) =>
      api<{ rootPath: string; cloned: boolean; error?: string }>("/api/integrations/github/clone", {
        method: "POST",
        body: JSON.stringify({
          url: target.url,
          targetDir: props.workspaceRoot || undefined,
        }),
      }),
    onSuccess: (result, target) => {
      if (result.error) {
        setError(result.error);
        return;
      }
      setMode("path");
      setPath(result.rootPath);
      if (target.suggestedName && !name) setName(target.suggestedName);
      inspect.mutate(result.rootPath);
    },
    onError: (err) => setError(err instanceof Error ? err.message : "clone_failed"),
  });

  const updatePath = (next: string) => {
    setPath(next);
    setError("");
    inspect.reset();
  };

  const submitLocal = (event: FormEvent) => {
    event.preventDefault();
    if (mode !== "path") return;
    setError("");
    if (!inspected) {
      inspect.mutate(path);
      return;
    }
    if (inspected.isGit) register.mutate();
  };

  return (
    <Modal title="Add repository" onClose={props.onClose}>
      <form onSubmit={submitLocal}>
        <div className="tab-strip" role="tablist">
          <button type="button" className={mode === "path" ? "active" : ""} onClick={() => setMode("path")}>
            Local path
          </button>
          <button type="button" className={mode === "url" ? "active" : ""} onClick={() => setMode("url")}>
            GitHub URL
          </button>
          <button type="button" className={mode === "search" ? "active" : ""} onClick={() => setMode("search")}>
            GitHub search
          </button>
        </div>
        <div className="modal-form">
          {mode === "path" ? (
            <>
              <label htmlFor="add-repo-path">
                Repository path
                <PathAutocomplete
                  id="add-repo-path"
                  inputRef={pathInputRef}
                  value={path}
                  onChange={updatePath}
                  onSelectGit={(nextPath) => inspect.mutate(nextPath)}
                  placeholder="~/projects/my-repo"
                />
              </label>
              <label>
                Display name (optional)
                <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Project" />
              </label>
              <label>
                Worktree parent override (optional)
                <input
                  value={worktreeParent}
                  onChange={(event) => setWorktreeParent(event.target.value)}
                  placeholder={inspected ? `Default: ${inspected.suggestedWorktreeParent}` : "/path/to/worktree-parent"}
                />
              </label>
              <div className="empty compact">
                Citadel scans the path, registers the git remote, and adds it to your tracked list. Nothing on disk is
                moved.
              </div>
              {inspected ? (
                <div className="empty compact">
                  {inspected.isGit ? (
                    <>
                      Default branch: <code>{inspected.defaultBranch ?? "?"}</code>
                      <br />
                      Remotes: <code>{inspected.remotes.join(", ") || "(none)"}</code>
                      <br />
                      Default worktree parent: <code>{inspected.suggestedWorktreeParent}</code>
                    </>
                  ) : (
                    <span style={{ color: "var(--color-danger)" }}>
                      {inspected.exists ? "Not a git repository" : "Path does not exist"}
                    </span>
                  )}
                </div>
              ) : null}
            </>
          ) : null}
          {mode === "url" ? (
            <>
              <label>
                GitHub URL
                <input
                  value={url}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setError("");
                  }}
                  placeholder="https://github.com/org/repo"
                />
              </label>
              <p className="empty compact">
                Citadel runs <code>gh repo clone</code> into{" "}
                <code>{props.workspaceRoot || "~/Workspace"}/&lt;repo&gt;</code> when the repo is not local yet, then
                registers the result here.
              </p>
              <div className="stack-form-actions">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!url || clone.isPending}
                  onClick={() => clone.mutate({ url })}
                >
                  {clone.isPending ? "Cloning..." : "Clone & continue"}
                </Button>
              </div>
            </>
          ) : null}
          {mode === "search" ? (
            <>
              <label>
                Search GitHub
                <input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setError("");
                  }}
                  placeholder="org/keyword"
                />
              </label>
              {search.data?.error ? <div className="empty compact">{search.data.error}</div> : null}
              <div className="check-list">
                {(search.data?.results ?? []).map((hit) => (
                  <button
                    key={hit.url}
                    type="button"
                    className="check-row"
                    onClick={() => {
                      const suggestedName = hit.name.split("/").pop();
                      clone.mutate({ url: hit.url, ...(suggestedName ? { suggestedName } : {}) });
                    }}
                  >
                    <span>
                      <strong>{hit.name}</strong>
                      <span className="command-result-meta">
                        {hit.description ?? hit.url}
                        {hit.defaultBranch ? ` · ${hit.defaultBranch}` : ""}
                      </span>
                    </span>
                    <span className="tone-pending">Clone</span>
                  </button>
                ))}
                {!search.data?.results?.length && debouncedQuery.length >= 2 && !search.isLoading ? (
                  <div className="empty compact">
                    No results yet. Searching requires <code>gh</code> authentication.
                  </div>
                ) : null}
              </div>
            </>
          ) : null}
          {error ? (
            <div className="empty compact" style={{ color: "var(--color-danger)" }}>
              {error}
            </div>
          ) : null}
        </div>
        {mode === "path" ? (
          <div className="modal-footer">
            <Button type="button" variant="secondary" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!path || inspect.isPending || register.isPending}>
              <FolderPlus size={13} />
              {register.isPending ? "Saving..." : inspected?.isGit ? "Register repo" : "Inspect & add"}
            </Button>
          </div>
        ) : (
          <div className="modal-footer">
            <Button type="button" variant="secondary" onClick={props.onClose}>
              Close
            </Button>
          </div>
        )}
      </form>
    </Modal>
  );
}
