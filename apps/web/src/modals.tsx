import type { Repo } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import { Check, Search, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api, queryClient } from "./api.js";
import { Button } from "./components/ui/button.js";
import { type GroupKey, type NavigatorGrouping, normalizeNavigatorGrouping } from "./navigator-groups.js";
import { repoNameWithOwner } from "./repo-labels.js";
import { useToast } from "./toast.js";
import { useOverlayPresent } from "./use-overlay-present.js";

const GROUP_BY_OPTIONS: Array<{ id: GroupKey; label: string; hint: string }> = [
  { id: "workspace", label: "Workspace", hint: "workspace -> worktrees" },
  { id: "repo", label: "Repository", hint: "citadel / skills / ..." },
  { id: "status", label: "Status", hint: "running / review / idle" },
  { id: "namespace", label: "Namespace", hint: "demo / platform / uncategorized" },
];

type GroupByMenuProps = {
  value: NavigatorGrouping;
  onChange: (next: NavigatorGrouping) => void;
  onClose: () => void;
  containerRef?: { current: HTMLElement | null };
};

export function GroupByMenu(props: GroupByMenuProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const onCloseRef = useRef(props.onClose);
  onCloseRef.current = props.onClose;
  const containerRefProp = props.containerRef;
  useEffect(() => {
    const onDocClick = (event: MouseEvent) => {
      const target = event.target as Node;
      const container = containerRefProp?.current ?? ref.current;
      if (container && !container.contains(target)) onCloseRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [containerRefProp]);
  return (
    <div ref={ref} className="cit-gb-menu" role="menu" aria-label="Group worktrees">
      <div className="cit-gb-menu-head">Group worktrees by</div>
      {GROUP_BY_OPTIONS.map((option) => (
        <button
          key={option.id}
          type="button"
          role="menuitemcheckbox"
          aria-checked={props.value.includes(option.id)}
          className={`cit-gb-opt ${props.value.includes(option.id) ? "is-active" : ""}`}
          onClick={() => props.onChange(nextGroupingSelection(props.value, option.id))}
        >
          <span className="cit-gb-opt-check">{props.value.includes(option.id) ? <Check size={11} /> : null}</span>
          <span className="cit-gb-opt-text">
            <span className="cit-gb-opt-label">{option.label}</span>
            <span className="cit-gb-opt-hint">{option.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

function nextGroupingSelection(current: NavigatorGrouping, option: GroupKey): NavigatorGrouping {
  const selected = current.includes(option);
  if (selected) {
    const next = current.filter((key) => key !== option);
    return normalizeNavigatorGrouping(next.length ? next : ["workspace"]);
  }
  if (option === "workspace") {
    return normalizeNavigatorGrouping([...current.filter((key) => key === "namespace"), "workspace"]);
  }
  if (option === "namespace") {
    return normalizeNavigatorGrouping(["namespace", "workspace"]);
  }
  const next = current.filter((key) => key !== "workspace");
  next.push(option);
  return normalizeNavigatorGrouping(next);
}

type CreateWorkspaceModalProps = {
  repos: Repo[];
  lastRepoId?: string;
  grouping?: NavigatorGrouping;
  intent?: CreateWorkspaceIntent;
  onClose: () => void;
  onCreated: (workspaceId: string) => void;
};

export type CreateWorkspaceIntent =
  | { kind: "auto" }
  | { kind: "attach-worktree"; workspaceId: string; workspaceName: string };

export type CreateWorkspaceContext = "workspace-home" | "attach-worktree";

export function resolveCreateWorkspaceContext(
  intent: CreateWorkspaceIntent | undefined,
  _grouping: NavigatorGrouping | undefined,
): CreateWorkspaceContext {
  if (intent?.kind === "attach-worktree") return "attach-worktree";
  return "workspace-home";
}

export function CreateWorkspaceModal(props: CreateWorkspaceModalProps) {
  useOverlayPresent();
  const toast = useToast();
  const creationContext = resolveCreateWorkspaceContext(props.intent, props.grouping);
  const initialRepo = props.repos.find((repo) => repo.id === props.lastRepoId)?.id ?? props.repos[0]?.id ?? "";
  const [name, setName] = useState("");
  const [worktreeName, setWorktreeName] = useState("");
  const [repoId, setRepoId] = useState(initialRepo);
  const [selectedRepoIds, setSelectedRepoIds] = useState<string[]>([]);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const trimmedName = name.trim();
  const trimmedWorktreeName = worktreeName.trim();

  useEffect(() => {
    if (!repoId && props.repos[0]) setRepoId(props.repos[0].id);
  }, [props.repos, repoId]);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  const create = useMutation({
    mutationFn: async () => {
      if (creationContext === "attach-worktree") {
        if (!repoId) throw new Error("repo_required");
        const workspaceId = props.intent?.kind === "attach-worktree" ? props.intent.workspaceId : "";
        const payload: Record<string, unknown> = { repoId, source: "default_branch" };
        if (trimmedWorktreeName) {
          payload.name = trimmedWorktreeName;
          payload.displayName = trimmedWorktreeName;
        }
        await api(`/api/workspaces/${encodeURIComponent(workspaceId)}/checkouts`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        return { workspaceId };
      }

      const result = await api<{ workspaceId: string }>("/api/workspaces/home", {
        method: "POST",
        body: JSON.stringify({ name: trimmedName, source: "scratch" }),
      });
      for (const selectedRepoId of selectedRepoIds) {
        await api(`/api/workspaces/${encodeURIComponent(result.workspaceId)}/checkouts`, {
          method: "POST",
          body: JSON.stringify({ repoId: selectedRepoId, source: "default_branch" }),
        });
      }
      return result;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      props.onCreated(result.workspaceId);
    },
    onError: (err) => {
      toast.push({
        tone: "error",
        message: `Workspace creation failed: ${err instanceof Error ? err.message : "create_failed"}`,
      });
    },
  });

  const modalTitle =
    creationContext === "attach-worktree"
      ? `Add worktree to ${props.intent?.kind === "attach-worktree" ? props.intent.workspaceName : "workspace"}`
      : "New workspace";
  const submitLabel = create.isPending
    ? "Creating..."
    : creationContext === "attach-worktree"
      ? "Add worktree"
      : selectedRepoIds.length
        ? "Create workspace and worktrees"
        : "Create workspace";
  const disabled =
    create.isPending ||
    (creationContext === "workspace-home" ? !trimmedName : !repoId || props.intent?.kind !== "attach-worktree");

  return (
    <Modal title={modalTitle} onClose={props.onClose}>
      <div className="modal-form workspace-modal">
        {creationContext === "workspace-home" ? (
          <>
            <label>
              Workspace name
              <input
                ref={nameRef}
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="workspace-name"
              />
            </label>
            {props.repos.length ? (
              <RepoMultiPicker repos={props.repos} selected={selectedRepoIds} onChange={setSelectedRepoIds} />
            ) : null}
          </>
        ) : (
          <>
            <RepoSinglePicker repos={props.repos} value={repoId} onChange={setRepoId} />
            <label>
              Worktree name
              <input
                ref={nameRef}
                value={worktreeName}
                onChange={(event) => setWorktreeName(event.target.value)}
                placeholder="Optional"
              />
            </label>
          </>
        )}
      </div>
      <div className="modal-footer">
        <Button type="button" variant="secondary" onClick={props.onClose}>
          Cancel
        </Button>
        <Button type="button" disabled={disabled} onClick={() => create.mutate()}>
          {submitLabel}
        </Button>
      </div>
    </Modal>
  );
}

function RepoMultiPicker(props: { repos: Repo[]; selected: string[]; onChange: (repoIds: string[]) => void }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterRepos(props.repos, query), [props.repos, query]);
  const selected = new Set(props.selected);
  return (
    <div className="workspace-repo-picker">
      <label>
        Initial worktrees
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search repositories..."
          spellCheck={false}
        />
      </label>
      <div className="workspace-repo-options">
        {filtered.map((repo) => {
          const checked = selected.has(repo.id);
          return (
            <label key={repo.id} className={`workspace-repo-option ${checked ? "is-selected" : ""}`}>
              <input
                type="checkbox"
                checked={checked}
                onChange={() => {
                  if (checked) props.onChange(props.selected.filter((id) => id !== repo.id));
                  else props.onChange([...props.selected, repo.id]);
                }}
              />
              <span>
                <strong>{repoNameWithOwner(repo)}</strong>
                <small>{repo.rootPath}</small>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function RepoSinglePicker(props: { repos: Repo[]; value: string; onChange: (repoId: string) => void }) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterRepos(props.repos, query), [props.repos, query]);
  return (
    <div className="workspace-repo-picker">
      <label>
        Repository
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search repositories..."
          spellCheck={false}
        />
      </label>
      <div className="workspace-repo-options" role="radiogroup">
        {filtered.map((repo) => {
          const checked = props.value === repo.id;
          return (
            <label key={repo.id} className={`workspace-repo-option ${checked ? "is-selected" : ""}`}>
              <input type="radio" checked={checked} onChange={() => props.onChange(repo.id)} />
              <span>
                <strong>{repoNameWithOwner(repo)}</strong>
                <small>{repo.rootPath}</small>
              </span>
            </label>
          );
        })}
      </div>
    </div>
  );
}

function filterRepos(repos: Repo[], query: string): Repo[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return repos;
  return repos.filter((repo) => {
    const label = repoNameWithOwner(repo).toLowerCase();
    return (
      label.includes(needle) || repo.name.toLowerCase().includes(needle) || repo.rootPath.toLowerCase().includes(needle)
    );
  });
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
