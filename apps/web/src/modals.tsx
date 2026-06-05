import type { Repo } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import { Check, Search, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api, queryClient } from "./api.js";
import {
  type StateResponse,
  addOptimisticCheckout,
  createOptimisticCheckout,
  reconcileOptimisticCheckout,
  removeOptimisticCheckout,
} from "./app-state.js";
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
  grouping?: NavigatorGrouping;
  intent?: CreateWorkspaceIntent;
  onClose: () => void;
  onCreated: (workspaceId: string, targetKey?: string) => void;
};

type CreateWorkspaceResult = {
  workspaceId: string;
  targetKey?: string;
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
  const [name, setName] = useState("");
  const [worktreeName, setWorktreeName] = useState("");
  const [selectedRepoIds, setSelectedRepoIds] = useState<string[]>([]);
  const [attachPending, setAttachPending] = useState(false);
  const mountedRef = useRef(true);
  const nameRef = useRef<HTMLInputElement | null>(null);
  const trimmedName = name.trim();
  const trimmedWorktreeName = worktreeName.trim();
  const singleSelectedAttachRepo = creationContext === "attach-worktree" && selectedRepoIds.length === 1;

  useEffect(() => {
    const validRepoIds = new Set(props.repos.map((repo) => repo.id));
    setSelectedRepoIds((previous) => {
      const next = previous.filter((repoId) => validRepoIds.has(repoId));
      return next.length === previous.length ? previous : next;
    });
  }, [props.repos]);
  useEffect(() => {
    nameRef.current?.focus();
  }, []);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const createHome = useMutation({
    mutationFn: async (): Promise<CreateWorkspaceResult> => {
      const result = await api<{ workspaceId: string }>("/api/workspaces/home", {
        method: "POST",
        body: JSON.stringify({ name: trimmedName, source: "scratch" }),
      });
      let targetKey: string | undefined;
      for (const selectedRepoId of selectedRepoIds) {
        const checkout = await api<{ checkoutId: string }>(
          `/api/workspaces/${encodeURIComponent(result.workspaceId)}/checkouts`,
          {
            method: "POST",
            body: JSON.stringify({ repoId: selectedRepoId, source: "default_branch" }),
          },
        );
        if (selectedRepoIds.length === 1) targetKey = `checkout:${checkout.checkoutId}`;
      }
      return targetKey ? { workspaceId: result.workspaceId, targetKey } : result;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      if (result.targetKey) props.onCreated(result.workspaceId, result.targetKey);
      else props.onCreated(result.workspaceId);
    },
    onError: (err) => {
      toast.push({
        tone: "error",
        message: `Workspace creation failed: ${err instanceof Error ? err.message : "create_failed"}`,
      });
    },
  });

  const createAttachWorktrees = async () => {
    if (!selectedRepoIds.length) return;
    const workspaceId = props.intent?.kind === "attach-worktree" ? props.intent.workspaceId : "";
    const pending: Array<{ repo: Repo; optimisticId: string | null; settled: boolean }> = [];
    setAttachPending(true);
    try {
      for (const selectedRepoId of selectedRepoIds) {
        const repo = props.repos.find((entry) => entry.id === selectedRepoId);
        if (!repo) throw new Error("repo_required");
        const requestedName = singleSelectedAttachRepo && trimmedWorktreeName ? trimmedWorktreeName : null;
        pending.push({
          repo,
          optimisticId: addOptimisticCheckoutToState({ workspaceId, repo, requestedName }),
          settled: false,
        });
      }

      const optimisticTarget =
        pending.length === 1 && pending[0]?.optimisticId ? `checkout:${pending[0].optimisticId}` : undefined;
      if (optimisticTarget) props.onCreated(workspaceId, optimisticTarget);
      else if (pending.some((entry) => entry.optimisticId)) props.onCreated(workspaceId);

      let targetKey: string | undefined;
      for (const entry of pending) {
        const payload: Record<string, unknown> = { repoId: entry.repo.id, source: "default_branch" };
        if (singleSelectedAttachRepo && trimmedWorktreeName) {
          payload.name = trimmedWorktreeName;
          payload.displayName = trimmedWorktreeName;
        }
        const result = await api<{ checkoutId: string }>(
          `/api/workspaces/${encodeURIComponent(workspaceId)}/checkouts`,
          {
            method: "POST",
            body: JSON.stringify(payload),
          },
        );
        if (entry.optimisticId) {
          const optimisticId = entry.optimisticId;
          entry.settled = true;
          queryClient.setQueryData<StateResponse>(["state"], (previous) =>
            reconcileOptimisticCheckout(previous, optimisticId, result.checkoutId),
          );
        }
        if (selectedRepoIds.length === 1) targetKey = `checkout:${result.checkoutId}`;
      }
      queryClient.invalidateQueries({ queryKey: ["state"] });
      if (targetKey) props.onCreated(workspaceId, targetKey);
      else props.onCreated(workspaceId);
    } catch (err) {
      for (const entry of pending) {
        if (!entry.optimisticId || entry.settled) continue;
        const optimisticId = entry.optimisticId;
        queryClient.setQueryData<StateResponse>(["state"], (previous) =>
          removeOptimisticCheckout(previous, optimisticId),
        );
      }
      queryClient.invalidateQueries({ queryKey: ["state"] });
      toast.push({
        tone: "error",
        message: `Workspace creation failed: ${err instanceof Error ? err.message : "create_failed"}`,
      });
    } finally {
      if (mountedRef.current) setAttachPending(false);
    }
  };

  const modalTitle =
    creationContext === "attach-worktree"
      ? `Add worktree to ${props.intent?.kind === "attach-worktree" ? props.intent.workspaceName : "workspace"}`
      : "New workspace";
  const pending = creationContext === "attach-worktree" ? attachPending : createHome.isPending;
  const submitLabel = pending
    ? "Creating..."
    : creationContext === "attach-worktree"
      ? selectedRepoIds.length > 1
        ? "Add worktrees"
        : "Add worktree"
      : selectedRepoIds.length
        ? "Create workspace and worktrees"
        : "Create workspace";
  const disabled =
    pending ||
    (creationContext === "workspace-home"
      ? !trimmedName
      : !selectedRepoIds.length || props.intent?.kind !== "attach-worktree");

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
            <RepoMultiPicker
              label="Repositories"
              repos={props.repos}
              selected={selectedRepoIds}
              onChange={setSelectedRepoIds}
            />
            <label>
              Worktree name
              <input
                ref={nameRef}
                value={worktreeName}
                onChange={(event) => setWorktreeName(event.target.value)}
                placeholder={selectedRepoIds.length > 1 ? "Auto-generated for multiple repos" : "Optional"}
                disabled={!singleSelectedAttachRepo}
              />
            </label>
          </>
        )}
      </div>
      <div className="modal-footer">
        <Button type="button" variant="secondary" onClick={props.onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          disabled={disabled}
          onClick={() => {
            if (creationContext === "attach-worktree") void createAttachWorktrees();
            else createHome.mutate();
          }}
        >
          {submitLabel}
        </Button>
      </div>
    </Modal>
  );
}

function RepoMultiPicker(props: {
  label?: string;
  repos: Repo[];
  selected: string[];
  onChange: (repoIds: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => filterRepos(props.repos, query), [props.repos, query]);
  const selected = new Set(props.selected);
  return (
    <div className="workspace-repo-picker">
      <label>
        {props.label ?? "Initial worktrees"}
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

function addOptimisticCheckoutToState(input: {
  workspaceId: string;
  repo: Repo;
  requestedName: string | null;
}): string | null {
  const state = queryClient.getQueryData<StateResponse>(["state"]);
  const workspace = state?.workspaces.find((entry) => entry.id === input.workspaceId);
  if (!state || !workspace) return null;
  const name = optimisticCheckoutName(input.repo, input.requestedName);
  const optimisticId = optimisticCheckoutId();
  const checkout = createOptimisticCheckout({
    id: optimisticId,
    workspace,
    repo: input.repo,
    name,
    displayName: input.requestedName,
    branch: name,
    now: new Date().toISOString(),
  });
  queryClient.setQueryData<StateResponse>(["state"], (previous) => addOptimisticCheckout(previous, checkout));
  return optimisticId;
}

function optimisticCheckoutName(repo: Repo, requestedName: string | null): string {
  const slug = (requestedName ?? repo.name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug || "checkout";
}

function optimisticCheckoutId(): string {
  return `co_optimistic_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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
