import type { AgentRuntime, Repo } from "@citadel/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { GripVertical, Search, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
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

type LinkedContext = {
  source: "scratch" | "issue" | "pr";
  issueKey?: string;
  issueUrl?: string;
  prUrl?: string;
  slackThreadUrl?: string;
};

const JIRA_KEY_FROM_URL = /\/browse\/([A-Z][A-Z0-9]+-\d+)/i;
const JIRA_KEY_BARE = /^[A-Z][A-Z0-9]+-\d+$/;
const GITHUB_PR_URL = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/i;
const SLACK_URL = /^https?:\/\/[a-z0-9.-]*slack\.com\//i;

// Parse the freeform "link" field — Jira issue, GitHub PR, or Slack thread —
// into the structured fields the workspace API expects. Returning a `source`
// here is what flips workspaceBranchName into JIRA-style branch generation.
function parseLinkedContext(input: string): LinkedContext {
  const value = input.trim();
  if (!value) return { source: "scratch" };
  const jiraUrl = value.match(JIRA_KEY_FROM_URL);
  if (jiraUrl?.[1]) return { source: "issue", issueKey: jiraUrl[1].toUpperCase(), issueUrl: value };
  if (JIRA_KEY_BARE.test(value)) return { source: "issue", issueKey: value.toUpperCase() };
  if (GITHUB_PR_URL.test(value)) return { source: "pr", prUrl: value };
  if (SLACK_URL.test(value)) return { source: "scratch", slackThreadUrl: value };
  return { source: "scratch" };
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

// Mirror packages/core's workspaceBranchName so we can preview the branch the
// daemon will create without round-tripping. Keep in sync if that helper moves.
function defaultBranchPreview(linked: LinkedContext, name: string): string {
  if (linked.source === "issue" && linked.issueKey) return linked.issueKey;
  const slug = slugify(name);
  return slug || "workspace";
}

function defaultNamePreview(linked: LinkedContext): string {
  if (linked.source === "issue" && linked.issueKey) return linked.issueKey.toLowerCase();
  return "workspace";
}

export function CreateWorkspaceModal(props: CreateWorkspaceModalProps) {
  const initialRepo = props.repos.find((repo) => repo.id === props.lastRepoId)?.id ?? props.repos[0]?.id ?? "";
  const [repoId, setRepoId] = useState(initialRepo);
  const [prompt, setPrompt] = useState("");
  const [linkInput, setLinkInput] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [error, setError] = useState("");

  const launchableRuntimes = useMemo(
    () => props.runtimes.filter((runtime) => runtime.id !== "shell" && runtime.health === "healthy"),
    [props.runtimes],
  );
  const defaultRuntimeId = useMemo(() => {
    if (launchableRuntimes.some((runtime) => runtime.id === "claude-code")) return "claude-code";
    return launchableRuntimes[0]?.id ?? "";
  }, [launchableRuntimes]);
  const [runtimeId, setRuntimeId] = useState(defaultRuntimeId);
  useEffect(() => {
    if (!runtimeId && defaultRuntimeId) setRuntimeId(defaultRuntimeId);
  }, [defaultRuntimeId, runtimeId]);

  const linked = useMemo(() => parseLinkedContext(linkInput), [linkInput]);
  const namePreview = defaultNamePreview(linked);
  const branchPreview = defaultBranchPreview(linked, name || namePreview);

  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    promptRef.current?.focus();
  }, []);

  const create = useMutation({
    mutationFn: async () => {
      const effectiveName = name.trim() || namePreview;
      const payload: Record<string, unknown> = {
        repoId,
        name: effectiveName,
        source: linked.source,
      };
      if (linked.issueKey) payload.issueKey = linked.issueKey;
      if (linked.issueUrl) payload.issueUrl = linked.issueUrl;
      if (linked.prUrl) payload.prUrl = linked.prUrl;
      if (linked.slackThreadUrl) payload.slackThreadUrl = linked.slackThreadUrl;
      const customBranch = branch.trim();
      if (customBranch) payload.existingBranch = customBranch;
      const result = await api<{ workspaceId: string }>("/api/workspaces", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (runtimeId) {
        const sessionPayload: Record<string, unknown> = {
          workspaceId: result.workspaceId,
          runtimeId,
        };
        if (prompt.trim()) sessionPayload.prompt = prompt.trim();
        await api("/api/agent-sessions", {
          method: "POST",
          body: JSON.stringify(sessionPayload),
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

  const linkBadge =
    linked.source === "issue"
      ? `Linked Jira: ${linked.issueKey}`
      : linked.source === "pr"
        ? "Linked GitHub PR"
        : linked.slackThreadUrl
          ? "Linked Slack thread"
          : "";

  return (
    <Modal title="New workspace" onClose={props.onClose}>
      <div className="modal-form workspace-modal">
        <label className="workspace-modal-prompt">
          Initial prompt
          <textarea
            ref={promptRef}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="What should the agent do? (optional — leave empty to start the agent with no instructions)"
            rows={4}
          />
        </label>
        <div className="workspace-modal-row">
          <label>
            Agent
            <select value={runtimeId} onChange={(event) => setRuntimeId(event.target.value)}>
              <option value="">No agent — workspace only</option>
              {launchableRuntimes.map((runtime) => (
                <option key={runtime.id} value={runtime.id}>
                  {runtime.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Repository
            <select value={repoId} onChange={(event) => setRepoId(event.target.value)}>
              {props.repos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {repo.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        <details className="workspace-modal-advanced">
          <summary>Optional: link, name, branch</summary>
          <label>
            Link Jira / GitHub PR / Slack URL
            <input
              value={linkInput}
              onChange={(event) => setLinkInput(event.target.value)}
              placeholder="ABC-123, https://…/browse/ABC-123, github.com/x/y/pull/42, or slack.com/…"
            />
            {linkBadge ? <span className="workspace-modal-badge">{linkBadge}</span> : null}
          </label>
          <div className="workspace-modal-row">
            <label>
              Workspace name
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={`Defaults to ${namePreview}`}
              />
            </label>
            <label>
              Branch
              <input
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder={`Defaults to ${branchPreview}`}
              />
            </label>
          </div>
        </details>
        {!launchableRuntimes.length ? (
          <div className="empty compact">
            No healthy agents configured. The workspace will be created without launching one.
          </div>
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
        <Button type="button" disabled={!repoId || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Creating…" : runtimeId ? "Create & launch agent" : "Create workspace"}
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
