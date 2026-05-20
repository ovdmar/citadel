import type { AgentRuntime, Repo } from "@citadel/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { GripVertical, Search, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { api, queryClient } from "./api.js";
import { Button } from "./components/ui/button.js";

export type GroupKey = "repo" | "status";

type GroupByOverlayProps = {
  value: GroupKey[];
  onChange: (next: GroupKey[]) => void;
  onClose: () => void;
};

export function GroupByOverlay(props: GroupByOverlayProps) {
  const [dragging, setDragging] = useState<GroupKey | null>(null);
  const labels: Record<GroupKey, string> = {
    repo: "Repository",
    status: "Status",
  };
  const ordered = props.value;
  const inactive = (["repo", "status"] as GroupKey[]).filter((key) => !ordered.includes(key));
  const toggle = (key: GroupKey) => {
    if (ordered.includes(key)) props.onChange(ordered.filter((entry) => entry !== key));
    else props.onChange([...ordered, key]);
  };
  const reorder = (source: GroupKey, target: GroupKey) => {
    if (source === target) return;
    const next = [...ordered];
    const sourceIndex = next.indexOf(source);
    const targetIndex = next.indexOf(target);
    if (sourceIndex < 0 || targetIndex < 0) return;
    next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, source);
    props.onChange(next);
  };
  return (
    <div className="popover group-by-overlay" aria-label="Group workspaces">
      <span className="command-section-label">Group by</span>
      {ordered.map((key) => (
        <div
          key={key}
          className={`group-by-row ${dragging === key ? "dragging" : ""}`}
          draggable
          onDragStart={() => setDragging(key)}
          onDragEnd={() => setDragging(null)}
          onDragOver={(event) => event.preventDefault()}
          onDrop={() => {
            if (dragging) reorder(dragging, key);
            setDragging(null);
          }}
        >
          <GripVertical size={12} />
          <input type="checkbox" checked readOnly aria-label={`${labels[key]} grouping enabled`} />
          <span>{labels[key]}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => toggle(key)}
            aria-label={`Remove ${labels[key]} grouping`}
            title={`Remove ${labels[key]} grouping`}
          >
            <X size={11} />
          </Button>
        </div>
      ))}
      {inactive.map((key) => (
        <div key={key} className="group-by-row">
          <GripVertical size={12} style={{ opacity: 0.3 }} />
          <input
            type="checkbox"
            checked={false}
            onChange={() => toggle(key)}
            aria-label={`${labels[key]} grouping disabled`}
          />
          <span>{labels[key]}</span>
        </div>
      ))}
      <Button type="button" variant="secondary" onClick={props.onClose}>
        Done
      </Button>
    </div>
  );
}

type AddRepoSearchHit = {
  name: string;
  url: string;
  description?: string;
  defaultBranch?: string;
};

type AddRepoModalProps = {
  onClose: () => void;
  workspaceRoot?: string;
};

export function AddRepoModal(props: AddRepoModalProps) {
  const [mode, setMode] = useState<"path" | "url" | "search">("path");
  const [path, setPath] = useState("");
  const [url, setUrl] = useState("");
  const [query, setQuery] = useState("");
  const [name, setName] = useState("");
  const [worktreeParent, setWorktreeParent] = useState("");
  const [error, setError] = useState("");

  const inspect = useMutation({
    mutationFn: () =>
      api<{ rootPath: string; isGit: boolean; suggestedWorktreeParent: string }>("/api/repos/inspect", {
        method: "POST",
        body: JSON.stringify({ rootPath: path }),
      }),
    onSuccess: (result) => {
      if (result.isGit && !worktreeParent) setWorktreeParent(result.suggestedWorktreeParent);
    },
  });

  const search = useQuery<{ results: AddRepoSearchHit[]; error?: string }>({
    queryKey: ["gh-repo-search", query],
    enabled: mode === "search" && query.trim().length >= 2,
    queryFn: () =>
      api<{ results: AddRepoSearchHit[]; error?: string }>(
        `/api/integrations/github/search?q=${encodeURIComponent(query)}`,
      ).catch((error_) => ({ results: [], error: error_ instanceof Error ? error_.message : "search_failed" })),
  });

  const register = useMutation({
    mutationFn: () =>
      api("/api/repos", {
        method: "POST",
        body: JSON.stringify({
          rootPath: path,
          name: name || undefined,
          worktreeParent: worktreeParent || undefined,
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
    onSuccess: (result) => {
      if (result.error) {
        setError(result.error);
        return;
      }
      setMode("path");
      setPath(result.rootPath);
      inspect.mutate();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "clone_failed"),
  });

  return (
    <Modal title="Add repository" onClose={props.onClose}>
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
            <label>
              Repository path
              <input value={path} onChange={(event) => setPath(event.target.value)} placeholder="/home/me/project" />
            </label>
            <label>
              Display name (optional)
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Project" />
            </label>
            <label>
              Worktree parent (optional)
              <input
                value={worktreeParent}
                onChange={(event) => setWorktreeParent(event.target.value)}
                placeholder={inspect.data?.suggestedWorktreeParent ?? "/path/to/worktree-parent"}
              />
            </label>
          </>
        ) : null}
        {mode === "url" ? (
          <>
            <label>
              GitHub URL
              <input
                value={url}
                onChange={(event) => setUrl(event.target.value)}
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
                {clone.isPending ? "Cloning…" : "Clone & continue"}
              </Button>
            </div>
          </>
        ) : null}
        {mode === "search" ? (
          <>
            <label>
              Search GitHub
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="org/keyword" />
            </label>
            {search.data?.error ? <div className="empty compact">{search.data.error}</div> : null}
            <div className="check-list">
              {(search.data?.results ?? []).map((hit) => (
                <button
                  key={hit.url}
                  type="button"
                  className="check-row"
                  onClick={() => clone.mutate({ url: hit.url })}
                >
                  <span>
                    <strong>{hit.name}</strong>
                    <span className="command-result-meta">{hit.description ?? hit.url}</span>
                  </span>
                  <span className="tone-pending">Clone</span>
                </button>
              ))}
              {!search.data?.results?.length && query.length >= 2 && !search.isLoading ? (
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
          <Button
            type="button"
            variant="secondary"
            onClick={() => inspect.mutate()}
            disabled={!path || inspect.isPending}
          >
            Inspect
          </Button>
          <Button
            type="button"
            disabled={!path || !inspect.data?.isGit || register.isPending}
            onClick={() => register.mutate()}
          >
            {register.isPending ? "Saving…" : "Register repo"}
          </Button>
        </div>
      ) : (
        <div className="modal-footer">
          <Button type="button" variant="secondary" onClick={props.onClose}>
            Close
          </Button>
        </div>
      )}
    </Modal>
  );
}

type CreateWorkspaceModalProps = {
  repos: Repo[];
  lastRepoId?: string;
  runtimes: AgentRuntime[];
  onClose: () => void;
  onCreated: (workspaceId: string) => void;
};

type RecentIssue = { key: string; title: string; updated?: string };
type Branch = { name: string; remote: boolean };

export function CreateWorkspaceModal(props: CreateWorkspaceModalProps) {
  const initialRepo = props.repos.find((repo) => repo.id === props.lastRepoId)?.id ?? props.repos[0]?.id ?? "";
  const [repoId, setRepoId] = useState(initialRepo);
  const [repoFilter, setRepoFilter] = useState("");
  const [tab, setTab] = useState<"scratch" | "issue" | "branch">("scratch");
  const [name, setName] = useState("");
  const [task, setTask] = useState("");
  const [runtimeId, setRuntimeId] = useState(
    props.runtimes.find((runtime) => runtime.id !== "shell" && runtime.health === "healthy")?.id ?? "",
  );
  const [issueKey, setIssueKey] = useState("");
  const [issueTitle, setIssueTitle] = useState("");
  const [branchFilter, setBranchFilter] = useState("");
  const [existingBranch, setExistingBranch] = useState("");
  const [error, setError] = useState("");

  const filteredRepos = props.repos.filter(
    (repo) =>
      repo.name.toLowerCase().includes(repoFilter.toLowerCase()) ||
      repo.rootPath.toLowerCase().includes(repoFilter.toLowerCase()),
  );

  const branches = useQuery<{ defaultBranch: string; local: string[]; remote: string[] }>({
    queryKey: ["repo-branches", repoId],
    enabled: Boolean(repoId),
    queryFn: () => api<{ defaultBranch: string; local: string[]; remote: string[] }>(`/api/repos/${repoId}/branches`),
  });

  const issues = useQuery<{ issues: RecentIssue[]; error?: string }>({
    queryKey: ["issue-suggestions", repoId, tab],
    enabled: tab === "issue" && Boolean(repoId),
    queryFn: () =>
      api<{ issues: RecentIssue[]; error?: string }>(`/api/integrations/issues/recent?repoId=${repoId}`).catch(
        (error_) => ({ issues: [], error: error_ instanceof Error ? error_.message : "issues_failed" }),
      ),
  });

  const create = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        repoId,
        name: name || existingBranch || issueKey || "workspace",
        source: tab === "scratch" ? "scratch" : tab === "branch" ? "imported" : "issue",
      };
      if (tab === "issue") {
        if (!issueKey) throw new Error("issue_required");
        payload.issueKey = issueKey;
        if (issueTitle) payload.issueTitle = issueTitle;
        payload.name = name || issueKey.toLowerCase();
      }
      if (tab === "branch") {
        if (!existingBranch) throw new Error("branch_required");
        payload.existingBranch = existingBranch;
        payload.name = name || existingBranch;
      }
      const result = await api<{ workspaceId: string }>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (task.trim() && runtimeId) {
        await api("/api/agent-sessions", {
          method: "POST",
          body: JSON.stringify({ workspaceId: result.workspaceId, runtimeId, prompt: task.trim() }),
        }).catch(() => {});
      }
      return result;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      props.onCreated(result.workspaceId);
    },
    onError: (err) => setError(err instanceof Error ? err.message : "create_failed"),
  });

  const branchList: Branch[] = useMemo(() => {
    const data = branches.data;
    if (!data) return [];
    const merged: Branch[] = [];
    for (const branch of data.local) merged.push({ name: branch, remote: false });
    for (const branch of data.remote) {
      if (!merged.some((entry) => entry.name === branch)) merged.push({ name: branch, remote: true });
    }
    if (!branchFilter) return merged.slice(0, 24);
    return merged.filter((branch) => branch.name.toLowerCase().includes(branchFilter.toLowerCase())).slice(0, 24);
  }, [branches.data, branchFilter]);

  useEffect(() => {
    if (!repoId && initialRepo) setRepoId(initialRepo);
  }, [initialRepo, repoId]);

  return (
    <Modal title="Create workspace" onClose={props.onClose}>
      <div className="modal-form">
        <label>
          Repository
          <input
            value={repoFilter}
            onChange={(event) => setRepoFilter(event.target.value)}
            placeholder="Filter repositories"
          />
        </label>
        <div className="check-list">
          {filteredRepos.map((repo) => (
            <button
              key={repo.id}
              type="button"
              className={`check-row ${repo.id === repoId ? "tone-success" : ""}`}
              onClick={() => setRepoId(repo.id)}
            >
              <span>
                <strong>{repo.name}</strong>
                <span className="command-result-meta">{repo.rootPath}</span>
              </span>
              {repo.id === repoId ? (
                <span className="tone-success">Selected</span>
              ) : (
                <span className="tone-pending">Pick</span>
              )}
            </button>
          ))}
          {!filteredRepos.length ? <div className="empty compact">No repositories match.</div> : null}
        </div>
        <div className="tab-strip" role="tablist">
          <button type="button" className={tab === "scratch" ? "active" : ""} onClick={() => setTab("scratch")}>
            From scratch
          </button>
          <button type="button" className={tab === "issue" ? "active" : ""} onClick={() => setTab("issue")}>
            From issue
          </button>
          <button type="button" className={tab === "branch" ? "active" : ""} onClick={() => setTab("branch")}>
            From branch
          </button>
        </div>
        {tab === "scratch" ? (
          <label>
            Workspace name
            <input value={name} onChange={(event) => setName(event.target.value)} placeholder="short-task-name" />
          </label>
        ) : null}
        {tab === "issue" ? (
          <>
            <label>
              Issue key
              <input value={issueKey} onChange={(event) => setIssueKey(event.target.value)} placeholder="ABC-123" />
            </label>
            <label>
              Issue title
              <input
                value={issueTitle}
                onChange={(event) => setIssueTitle(event.target.value)}
                placeholder="Optional title"
              />
            </label>
            <label>
              Workspace name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Defaults to issue key"
              />
            </label>
            {issues.data?.error ? <div className="empty compact">{issues.data.error}</div> : null}
            <div className="check-list">
              {(issues.data?.issues ?? []).slice(0, 8).map((issue) => (
                <button
                  key={issue.key}
                  type="button"
                  className="check-row"
                  onClick={() => {
                    setIssueKey(issue.key);
                    setIssueTitle(issue.title);
                  }}
                >
                  <span>
                    <strong>{issue.key}</strong>
                    <span className="command-result-meta">{issue.title}</span>
                  </span>
                  {issue.updated ? <span className="command-result-hint">{issue.updated}</span> : null}
                </button>
              ))}
              {!issues.data?.issues?.length && !issues.isLoading ? (
                <div className="empty compact">
                  No issue suggestions. Configure an issue provider to see assigned/created issues.
                </div>
              ) : null}
            </div>
          </>
        ) : null}
        {tab === "branch" ? (
          <>
            <label>
              Branch filter
              <input
                value={branchFilter}
                onChange={(event) => setBranchFilter(event.target.value)}
                placeholder="Search recent branches"
              />
            </label>
            <div className="check-list">
              {branchList.map((branch) => (
                <button
                  key={`${branch.name}-${branch.remote ? "r" : "l"}`}
                  type="button"
                  className={`check-row ${branch.name === existingBranch ? "tone-success" : ""}`}
                  onClick={() => setExistingBranch(branch.name)}
                >
                  <span>
                    <strong>{branch.name}</strong>
                    <span className="command-result-meta">{branch.remote ? "remote" : "local"}</span>
                  </span>
                  {branch.name === existingBranch ? <span className="tone-success">Selected</span> : null}
                </button>
              ))}
              {!branchList.length && !branches.isLoading ? (
                <div className="empty compact">No branches found for this repository.</div>
              ) : null}
            </div>
          </>
        ) : null}
        {props.runtimes.length ? (
          <>
            <label>
              Agent task (optional)
              <textarea
                value={task}
                onChange={(event) => setTask(event.target.value)}
                placeholder="Describe what the agent should do on launch. Leave empty to start without an agent."
                rows={2}
              />
            </label>
            {task.trim() ? (
              <label>
                Launch with
                <select value={runtimeId} onChange={(event) => setRuntimeId(event.target.value)}>
                  {props.runtimes
                    .filter((runtime) => runtime.id !== "shell")
                    .map((runtime) => (
                      <option key={runtime.id} value={runtime.id} disabled={runtime.health !== "healthy"}>
                        {runtime.displayName} ({runtime.health})
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
          </>
        ) : null}
        {error ? (
          <div className="empty compact" style={{ color: "var(--color-danger)" }}>
            {error}
          </div>
        ) : null}
      </div>
      <div className="modal-footer">
        <Button type="button" variant="secondary" onClick={props.onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={
            !repoId ||
            create.isPending ||
            (tab === "issue" && !issueKey) ||
            (tab === "branch" && !existingBranch) ||
            (tab === "scratch" && !name)
          }
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Creating…" : task.trim() ? "Create & launch" : "Create workspace"}
        </Button>
      </div>
    </Modal>
  );
}

export function Modal(props: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props.onClose]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={props.onClose}>
      <dialog open className="modal-frame" aria-label={props.title} onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <Search size={14} aria-hidden />
          <h2>{props.title}</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={props.onClose}
            aria-label="Close"
            title="Close (Esc)"
          >
            <X size={14} />
          </Button>
        </div>
        <div className="modal-body">{props.children}</div>
      </dialog>
    </div>
  );
}
