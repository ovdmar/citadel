import type {
  Namespace,
  Operation,
  PullRequestSummary,
  Workspace,
  WorkspaceDirtySummary,
  WorkspaceSession,
} from "@citadel/contracts";
import type { LifecycleTone } from "@citadel/core";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Folder, GitBranch, Home, ShieldAlert, ShieldCheck, ShieldQuestion, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { api, queryClient } from "./api.js";
import { type StateResponse, useOptimisticRemove, useStateQuery } from "./app-state.js";
import { pickReadableForeground } from "./color-contrast.js";
import { Chip } from "./components/ui/chip.js";
import { encodeReorderMimeType, findReorderMimeType, parseReorderMimeType } from "./navigator-order.js";
import { type AttentionSessionIds, deriveWorkspaceDisplayLifecycleTone } from "./session-status-display.js";
import { useToast } from "./toast.js";
import { useOverlayPresent } from "./use-overlay-present.js";
import "./workspace-status-dot.css";

export type WorkspaceCardData = {
  workspace: Workspace;
  sessions: WorkspaceSession[];
  operation?: Operation | null;
  pullRequest?: PullRequestSummary | null;
  approval?: ApprovalTone | undefined;
  // When provided, skip the global state lookup and use these directly.
  // Callers rendering many cards should build the namespace Map once at the
  // parent so we avoid O(n*m) lookups across a large list.
  namespace?: Namespace | null;
  namespaces?: Namespace[];
};

export type PrTone = "missing" | "pending" | "passing" | "failing" | "merged" | "conflicting";
export type ApprovalTone = "none" | "pending" | "changes" | "approved";

export function lifecycleToneClass(tone: LifecycleTone): string {
  switch (tone) {
    case "never-started":
      return "cit-pulse-idle";
    case "running":
      return "cit-pulse-run";
    case "done":
      return "cit-pulse-idle";
    case "attention":
      return "cit-pulse-bad";
  }
}

function lifecycleToneAriaSuffix(tone: LifecycleTone): string {
  switch (tone) {
    case "attention":
      return ", agent needs attention";
    case "running":
      return ", agent running";
    case "done":
      return ", agent done";
    case "never-started":
      return ", agent never started";
  }
}

export type WorkspaceReorderProps = {
  groupPath: string;
  visibleIds: readonly string[];
  onReorder: (draggedId: string, targetIndex: number) => void;
};

export function WorkspaceCard(
  props: WorkspaceCardData & {
    active: boolean;
    onSelect: () => void;
    // `"namespace"` enables the legacy namespace-drop drag payload used to
    // reassign workspaces between namespace buckets. `null` (or absent) keeps
    // the namespace-drop disabled while intra-group reorder remains available.
    dropTarget?: "namespace" | null;
    // When provided, the card joins the intra-group reorder flow: drags emit
    // a reorder mime type encoding the source group path, and drops on this
    // card splice the dragged workspace into the visible-id sequence.
    reorder?: WorkspaceReorderProps;
    // Back-compat shim — kept so namespaces-view.tsx (which still passes
    // `draggable={true}`) doesn't have to change in this PR. Internally
    // treated as `dropTarget: "namespace"` to preserve existing behavior.
    draggable?: boolean;
    hideBranch?: boolean;
    branchLabel?: string | null | undefined;
    branchTitle?: string | undefined;
    cardTitle?: string | undefined;
    displayTitle?: string;
    onRename?: (name: string) => Promise<unknown> | unknown;
    renameLabel?: string;
    rightControl?: ReactNode;
    disableDrop?: boolean;
    allowRootDrop?: boolean;
    prToneOverride?: PrTone | undefined;
    diffOverride?: { additions: number | null; deletions: number | null } | undefined;
    lifecyclePullRequest?: PullRequestSummary | null | undefined;
    unseenAttentionSessionIds?: AttentionSessionIds | undefined;
    onDropFocus?: (() => void) | undefined;
  },
) {
  const { workspace, pullRequest } = props;
  const titleDisplay = props.displayTitle ?? workspaceDisplayTitle(workspace);
  const prTone = props.prToneOverride ?? (pullRequest ? prToneFor(pullRequest) : "missing");
  const approvalTone = props.approval ?? approvalToneFor(pullRequest);
  const lifecycleTone = deriveWorkspaceDisplayLifecycleTone({
    sessions: props.sessions,
    pullRequest: props.lifecyclePullRequest === undefined ? (pullRequest ?? null) : props.lifecyclePullRequest,
    unseenAttentionSessionIds: props.unseenAttentionSessionIds,
  });
  const agentToneSuffix = lifecycleToneAriaSuffix(lifecycleTone);
  const branchLabel = props.branchLabel === undefined ? workspace.branch : props.branchLabel;
  const branchTitle = props.branchTitle ?? branchLabel;
  const additions = props.diffOverride ? props.diffOverride.additions : (pullRequest?.additions ?? null);
  const deletions = props.diffOverride ? props.diffOverride.deletions : (pullRequest?.deletions ?? null);
  const hasDiff = additions !== null || deletions !== null;
  const lifecycleText =
    workspace.lifecycle === "creating"
      ? props.operation?.message
        ? `${props.operation.message} · ${props.operation.progress}%`
        : "Setting up workspace…"
      : workspace.lifecycle === "failed"
        ? (props.operation?.error ?? "Workspace setup failed")
        : null;

  // Only hit the global state query when callers haven't already passed the
  // resolved namespace / namespace list in via props.
  const needsFallback = props.namespace === undefined && props.namespaces === undefined;
  const fallbackState = useStateQuery({ enabled: needsFallback });
  const namespacesForPicker = props.namespaces ?? fallbackState.data?.namespaces ?? [];
  const namespace =
    props.namespace !== undefined
      ? props.namespace
      : workspace.namespaceId
        ? (namespacesForPicker.find((entry) => entry.id === workspace.namespaceId) ?? null)
        : null;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(titleDisplay);
  const [confirmDrop, setConfirmDrop] = useState(false);
  const [showNamespaceMenu, setShowNamespaceMenu] = useState(false);
  const editInputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!editing) setDraft(titleDisplay);
  }, [titleDisplay, editing]);
  useEffect(() => {
    if (editing) editInputRef.current?.select();
  }, [editing]);

  const rename = useMutation({
    mutationFn: (name: string) => {
      if (props.onRename) return Promise.resolve(props.onRename(name));
      return api(`/api/workspaces/${workspace.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      });
    },
    onSuccess: () => {
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  // Hover indicator state for intra-group reorder drops. `null` means no
  // drop pending; `"above"` / `"below"` controls a CSS line above or below
  // the card via the `is-drop-above` / `is-drop-below` class.
  const [reorderIndicator, setReorderIndicator] = useState<"above" | "below" | null>(null);

  const namespaceMode = props.dropTarget === "namespace" || props.draggable === true;
  const reorder = props.reorder;
  // Drag payload:
  //   - In namespace mode: emit `application/x-citadel-workspace-id` so
  //     namespace drop targets in the nav/dashboard can reassign via
  //     /api/namespaces/assign. Existing behavior.
  //   - In reorder mode: emit `application/x-citadel-workspace-reorder+<hex>`
  //     so other cards in the SAME group accept the drop during dragover.
  const canDrag = namespaceMode || Boolean(reorder);
  const dragHandlers = canDrag
    ? {
        draggable: true,
        onDragStart: (event: React.DragEvent) => {
          if (namespaceMode) {
            event.dataTransfer.setData("application/x-citadel-workspace-id", workspace.id);
          }
          if (reorder) {
            event.dataTransfer.setData(encodeReorderMimeType(reorder.groupPath), workspace.id);
          }
          event.dataTransfer.effectAllowed = "move";
        },
      }
    : {};

  // Drop handlers for intra-group reorder. The container detects an
  // incoming reorder drag via `dataTransfer.types` (which IS available on
  // `dragover`), early-exits when the source group path differs from this
  // card's group path, and otherwise renders an above/below indicator
  // based on the cursor's Y position relative to the card midpoint.
  const reorderDropHandlers = reorder
    ? {
        onDragOver: (event: React.DragEvent) => {
          const sourceMime = findReorderMimeType(Array.from(event.dataTransfer.types));
          if (!sourceMime) return;
          const sourceGroup = parseReorderMimeType(sourceMime);
          if (sourceGroup !== reorder.groupPath) return; // cross-group drop — silently ignored
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          const rect = event.currentTarget.getBoundingClientRect();
          const midpoint = rect.top + rect.height / 2;
          setReorderIndicator(event.clientY < midpoint ? "above" : "below");
        },
        onDragLeave: () => setReorderIndicator(null),
        onDrop: (event: React.DragEvent) => {
          const sourceMime = findReorderMimeType(Array.from(event.dataTransfer.types));
          if (!sourceMime) return;
          const sourceGroup = parseReorderMimeType(sourceMime);
          if (sourceGroup !== reorder.groupPath) return;
          event.preventDefault();
          const draggedId = event.dataTransfer.getData(sourceMime);
          if (!draggedId || draggedId === workspace.id) {
            setReorderIndicator(null);
            return;
          }
          const targetVisibleIndex = reorder.visibleIds.indexOf(workspace.id);
          if (targetVisibleIndex === -1) {
            setReorderIndicator(null);
            return;
          }
          // "above" → land before the target card; "below" → land after.
          const insertIndex = reorderIndicator === "below" ? targetVisibleIndex + 1 : targetVisibleIndex;
          reorder.onReorder(draggedId, insertIndex);
          setReorderIndicator(null);
        },
      }
    : {};

  const wrapClassName = [
    "workspace-card-wrap",
    props.rightControl ? "has-right-control" : null,
    reorderIndicator === "above" ? "is-drop-above" : null,
    reorderIndicator === "below" ? "is-drop-below" : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={wrapClassName} {...reorderDropHandlers}>
      <button
        type="button"
        className={`workspace-card ${props.active ? "active" : ""}`}
        // The .active state paints the card with a dark navy background
        // regardless of cockpit theme. Mark it as on-dark so descendants
        // (e.g. .workspace-card-issue chip whose color tracks --color-action,
        // which is also dark navy on light cockpit) can flip to a light-fg
        // variant via [data-cit-on-dark="true"] selectors.
        data-cit-on-dark={props.active ? "true" : undefined}
        {...dragHandlers}
        onClick={() => {
          if (!editing) props.onSelect();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setShowNamespaceMenu(true);
        }}
        aria-label={`Open workspace ${workspace.name}${agentToneSuffix}`}
        title={props.cardTitle}
      >
        <span
          className={`workspace-card-agent tone-${prTone} ${workspace.kind === "root" ? "root" : ""}`}
          title={
            workspace.kind === "root"
              ? "Repository root workspace"
              : pullRequest
                ? `PR #${pullRequest.number} · ${prTone}`
                : "No PR yet"
          }
        >
          {workspace.kind === "root" ? <Home size={14} /> : <GitBranch size={14} />}
        </span>
        <span className="workspace-card-main">
          <span className="workspace-card-title">
            {/* Status dot is a flex sibling of <strong>, NOT a child of it —
                <strong> has overflow: hidden for title-truncation, which
                would clip the cit-pulse-run ripple animation's left edge. */}
            <span
              className={`cit-pulse cit-pulse-sm ${lifecycleToneClass(lifecycleTone)} workspace-status-dot`}
              aria-hidden="true"
            />
            {editing ? (
              <input
                ref={editInputRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onClick={(event) => event.stopPropagation()}
                onBlur={() => {
                  if (draft.trim() && draft.trim() !== titleDisplay) rename.mutate(draft.trim());
                  else setEditing(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") (event.target as HTMLInputElement).blur();
                  else if (event.key === "Escape") {
                    setDraft(titleDisplay);
                    setEditing(false);
                  }
                }}
                aria-label={props.renameLabel ?? "Rename workspace"}
              />
            ) : (
              <strong
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  setEditing(true);
                }}
                title={titleDisplay}
              >
                {workspace.issueKey ? <span className="workspace-card-issue">{workspace.issueKey}</span> : null}
                {titleDisplay}
              </strong>
            )}
          </span>
          {!props.hideBranch && branchLabel ? (
            <span className="workspace-card-branch" title={branchTitle ?? undefined}>
              {branchLabel}
            </span>
          ) : null}
          {lifecycleText ? (
            <span className={`workspace-card-lifecycle ${workspace.lifecycle}`} title={lifecycleText}>
              {lifecycleText}
            </span>
          ) : null}
        </span>
        <span className="workspace-card-right" aria-hidden>
          {namespace ? (
            <Chip
              data-variant-source="namespace"
              icon={<Folder size={10} />}
              title={`Namespace: ${namespace.name}`}
              className="namespace-pill"
              style={
                namespace.color
                  ? { background: namespace.color, color: pickReadableForeground(namespace.color) }
                  : undefined
              }
            >
              {namespace.name}
            </Chip>
          ) : null}
          {/* TODO(implement-task): migrate the approval-pill (icon-only,
            transparent fill, tonal color) and the workspace-card-diff
            (two-color add/del display) into design-system primitives in a
            follow-up PR. They render correctly today via bespoke CSS but
            don't map cleanly onto Badge/Chip's surface-fill conventions
            and need design input before rewriting. */}
          {hasDiff ? (
            <span className="workspace-card-diff" title="Lines changed in this PR">
              <span className="diff-add">+{additions ?? 0}</span>
              <span className="diff-del">-{deletions ?? 0}</span>
            </span>
          ) : null}
          {props.rightControl ? <span className="workspace-card-right-control-spacer" /> : null}
          {approvalTone === "pending" ? null : (
            <span className={`approval-pill tone-${approvalTone}`} title={`Approval: ${approvalTone}`}>
              {approvalTone === "approved" ? (
                <ShieldCheck size={13} />
              ) : approvalTone === "changes" ? (
                <ShieldAlert size={13} />
              ) : (
                <ShieldQuestion size={13} />
              )}
            </span>
          )}
        </span>
      </button>
      {props.rightControl ? <span className="workspace-card-right-control">{props.rightControl}</span> : null}
      {(workspace.kind === "root" && !props.allowRootDrop) || props.disableDrop ? null : (
        <button
          type="button"
          className="workspace-card-drop"
          aria-label={`Drop workspace ${workspace.name}`}
          title="Drop workspace"
          onClick={() => setConfirmDrop(true)}
        >
          <X size={11} />
        </button>
      )}
      {confirmDrop ? (
        <DropWorkspaceDialog
          workspace={workspace}
          onDropFocus={props.onDropFocus}
          onClose={() => setConfirmDrop(false)}
        />
      ) : null}
      {showNamespaceMenu ? (
        <NamespacePickerDialog
          workspace={workspace}
          namespaces={namespacesForPicker}
          onClose={() => setShowNamespaceMenu(false)}
        />
      ) : null}
    </div>
  );
}

function NamespacePickerDialog(props: { workspace: Workspace; namespaces: Namespace[]; onClose: () => void }) {
  useOverlayPresent();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const newNameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (creating) newNameRef.current?.focus();
  }, [creating]);

  const assign = useMutation({
    mutationFn: (namespaceId: string | null) =>
      api("/api/namespaces/assign", {
        method: "POST",
        body: JSON.stringify({ workspaceId: props.workspace.id, namespaceId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      props.onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "assign_failed"),
  });

  // Create-and-assign in a single click. createNamespace is idempotent on name
  // (returns the existing row with `created: false`) — the assign step still
  // runs either way, which is the intent here.
  const createAndAssign = useMutation({
    mutationFn: async (name: string) => {
      const created = await api<{ namespace: Namespace; created: boolean }>("/api/namespaces", {
        method: "POST",
        body: JSON.stringify({ name }),
      });
      await api("/api/namespaces/assign", {
        method: "POST",
        body: JSON.stringify({ workspaceId: props.workspace.id, namespaceId: created.namespace.id }),
      });
      return created.namespace;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      props.onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : "create_failed"),
  });

  return (
    <div className="drop-workspace-backdrop" onMouseDown={props.onClose}>
      <dialog
        className="drop-workspace-dialog"
        aria-label="Move workspace to namespace"
        open
        onMouseDown={(event) => event.stopPropagation()}
      >
        <strong>Move "{props.workspace.name}" to…</strong>
        <div className="namespace-picker-list">
          {creating ? (
            <form
              className="namespace-picker-create"
              onSubmit={(event) => {
                event.preventDefault();
                const trimmed = newName.trim();
                if (!trimmed) return;
                setError(null);
                createAndAssign.mutate(trimmed);
              }}
            >
              <input
                ref={newNameRef}
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="New namespace name"
                aria-label="New namespace name"
                disabled={createAndAssign.isPending}
              />
              <button
                type="submit"
                className="drop-workspace-confirm"
                disabled={!newName.trim() || createAndAssign.isPending}
              >
                {createAndAssign.isPending ? "Creating…" : "Create & move"}
              </button>
              <button
                type="button"
                className="drop-workspace-cancel"
                onClick={() => {
                  setCreating(false);
                  setNewName("");
                  setError(null);
                }}
                disabled={createAndAssign.isPending}
              >
                Cancel
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="check-row namespace-picker-new"
              onClick={() => setCreating(true)}
              disabled={assign.isPending}
            >
              + Create new namespace and put workspace into it
            </button>
          )}
          <button
            type="button"
            className="check-row"
            onClick={() => assign.mutate(null)}
            disabled={!props.workspace.namespaceId || assign.isPending}
          >
            Uncategorized
          </button>
          {props.namespaces.map((ns) => (
            <button
              key={ns.id}
              type="button"
              className="check-row"
              onClick={() => assign.mutate(ns.id)}
              disabled={props.workspace.namespaceId === ns.id || assign.isPending}
            >
              {ns.name}
            </button>
          ))}
        </div>
        {error ? <p className="drop-workspace-error">{error}</p> : null}
        <div className="drop-workspace-actions">
          <button type="button" className="drop-workspace-cancel" onClick={props.onClose}>
            Close
          </button>
        </div>
      </dialog>
    </div>
  );
}

type DropResult = {
  removed: boolean;
  archived: boolean;
  dirty: boolean;
  error?: string | null;
  // Present when removal was blocked by dirty state. Lists are bounded
  // server-side (≤50 files, ≤20 unpushed commits) so the dialog stays
  // readable even on heavily-modified worktrees.
  dirtySummary?: WorkspaceDirtySummary | null;
};

type DropCheckResult = {
  removable: boolean;
  dirty: boolean;
  reason: "ok" | "root_workspace" | "non_empty_workspace" | "dirty";
  dirtySummary?: WorkspaceDirtySummary | null;
  error?: string | null;
};

function DropWorkspaceDialog(props: {
  workspace: Workspace;
  onDropFocus?: (() => void) | undefined;
  onClose: () => void;
}) {
  useOverlayPresent();
  const optimistic = useOptimisticRemove();
  const toast = useToast();
  const workspaceId = props.workspace.id;
  const check = useQuery({
    queryKey: ["workspace-removal-check", workspaceId],
    queryFn: async (): Promise<DropCheckResult> => {
      const response = await fetch(`/api/workspaces/${workspaceId}/removal-check`);
      const body = (await response.json().catch(() => ({}))) as Partial<DropCheckResult> & { error?: string };
      if (!response.ok && response.status !== 409) {
        throw new Error(body.error ?? "workspace_removal_check_failed");
      }
      return {
        removable: Boolean(body.removable),
        dirty: Boolean(body.dirty),
        reason:
          body.reason === "root_workspace" || body.reason === "non_empty_workspace" || body.reason === "dirty"
            ? body.reason
            : "ok",
        dirtySummary: body.dirtySummary ?? null,
        error: body.error ?? null,
      };
    },
    retry: false,
    refetchOnWindowFocus: false,
  });
  const drop = useMutation({
    mutationFn: async (): Promise<DropResult> => {
      const response = await fetch(`/api/workspaces/${workspaceId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
      const body = (await response.json().catch(() => ({}))) as Partial<DropResult> & {
        error?: string;
        dirtySummary?: WorkspaceDirtySummary;
      };
      return {
        removed: Boolean(body.removed),
        archived: Boolean(body.archived),
        dirty: Boolean(body.dirty),
        error: body.error ?? null,
        dirtySummary: body.dirtySummary ?? null,
      };
    },
    // AC4 — optimistic remove: snapshot the previous cache, drop the row
    // immediately, and add the workspace id to the optimistic-remove
    // blacklist so the 5s refetch / SSE invalidation can't resurrect it
    // mid-teardown. `useFilteredStateQuery` (consumed by the cockpit's
    // active-workspace selector and the navigator) subtracts blacklisted
    // ids on read, so the workspace disappears for every consumer.
    onMutate: () => {
      props.onDropFocus?.();
      optimistic.add(workspaceId);
      const previous = queryClient.getQueryData<StateResponse>(["state"]);
      if (previous) {
        queryClient.setQueryData<StateResponse>(["state"], {
          ...previous,
          workspaces: previous.workspaces.filter((w) => w.id !== workspaceId),
        });
      }
      return { previous };
    },
    onSuccess: (result, _vars, context) => {
      if (result.removed) {
        queryClient.invalidateQueries({ queryKey: ["state"] });
        props.onClose();
        return;
      }
      // Teardown blocked (dirty / hook failed) — restore the optimistic
      // cache write so the workspace reappears in the nav. The dialog
      // stays open with the structured summary / error message; for users
      // who navigated away, the toast below is the cause-and-effect cue.
      if (context?.previous) queryClient.setQueryData(["state"], context.previous);
      queryClient.invalidateQueries({ queryKey: ["state"] });
      const reason = result.dirty ? "uncommitted changes or unpushed commits" : (result.error ?? "teardown failed");
      toast.push({ tone: "error", message: `Drop "${props.workspace.name}" failed: ${reason}` });
    },
    onError: (error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(["state"], context.previous);
      queryClient.invalidateQueries({ queryKey: ["state"] });
      toast.push({
        tone: "error",
        message: `Drop "${props.workspace.name}" failed: ${error instanceof Error ? error.message : "network error"}`,
      });
    },
    onSettled: () => {
      // Always clear the blacklist on settle — the cache is now authoritative
      // (either the workspace is gone or it was restored above).
      optimistic.remove(workspaceId);
    },
  });
  const result = drop.data;
  const preflight = check.data;
  const preflightBlocked = Boolean(preflight && !preflight.removable);
  const dirtyBlocked =
    Boolean(preflight && !preflight.removable && preflight.dirty) || Boolean(result && !result.removed && result.dirty);
  const rootBlocked = Boolean(preflight && !preflight.removable && preflight.reason === "root_workspace");
  const nonEmptyBlocked = Boolean(preflight && !preflight.removable && preflight.reason === "non_empty_workspace");
  const teardownBlocked = Boolean(result && !result.removed && !result.dirty);
  const dirtySummary = result?.dirtySummary ?? preflight?.dirtySummary ?? null;
  const hasStructuredSummary =
    dirtyBlocked && dirtySummary !== null && (dirtySummary.files.length > 0 || dirtySummary.unpushedCommits.length > 0);
  const dropDisabled = drop.isPending || check.isLoading || check.isError || preflightBlocked || !preflight?.removable;
  return (
    <div className="drop-workspace-backdrop" onMouseDown={props.onClose}>
      <dialog
        className="drop-workspace-dialog"
        aria-label={`Drop workspace ${props.workspace.name}`}
        open
        onMouseDown={(event) => event.stopPropagation()}
      >
        <strong>Drop "{props.workspace.name}"?</strong>
        {props.workspace.kind === "root" && props.workspace.mode === "structured" ? (
          <p>This removes the structured workspace Home directory. Remove any worktrees under it first.</p>
        ) : (
          <p>
            This runs the repo's teardown hook (if any) and removes the git worktree. Deletion is blocked if the
            worktree has uncommitted changes or unpushed commits.
          </p>
        )}
        {check.isLoading ? <p className="empty compact">Checking workspace status…</p> : null}
        {check.error instanceof Error ? <p className="drop-workspace-error">{check.error.message}</p> : null}
        {dirtyBlocked ? (
          <p className="drop-workspace-error">
            Workspace has uncommitted changes or unpushed commits. Commit and push before dropping.
          </p>
        ) : null}
        {rootBlocked ? <p className="drop-workspace-error">The root workspace is not removable.</p> : null}
        {nonEmptyBlocked ? (
          <p className="drop-workspace-error">Remove this workspace's worktrees before dropping the Home.</p>
        ) : null}
        {hasStructuredSummary && dirtySummary ? (
          <fieldset className="drop-workspace-summary" aria-label="Blocking changes">
            {dirtySummary.files.length > 0 ? (
              <details open>
                <summary>Uncommitted changes ({dirtySummary.files.length})</summary>
                <ul className="drop-workspace-summary-list">
                  {dirtySummary.files.map((file) => (
                    <li key={file.path}>
                      <code className="drop-workspace-summary-status">{file.status}</code>
                      <span className="drop-workspace-summary-path">{file.path}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {dirtySummary.unpushedCommits.length > 0 ? (
              <details open>
                <summary>Unpushed commits ({dirtySummary.unpushedCommits.length})</summary>
                <ul className="drop-workspace-summary-list">
                  {dirtySummary.unpushedCommits.map((commit) => (
                    <li key={commit.sha}>
                      <code className="drop-workspace-summary-sha">{commit.sha.slice(0, 7)}</code>
                      <span className="drop-workspace-summary-subject">{commit.subject}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </fieldset>
        ) : null}
        {teardownBlocked ? (
          <p className="drop-workspace-error">Teardown hook failed{result?.error ? `: ${result.error}` : "."}</p>
        ) : null}
        {drop.error instanceof Error ? <p className="drop-workspace-error">{drop.error.message}</p> : null}
        <div className="drop-workspace-actions">
          <button type="button" className="drop-workspace-cancel" onClick={props.onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="drop-workspace-confirm"
            onClick={() => drop.mutate()}
            disabled={dropDisabled}
          >
            {drop.isPending ? "Dropping..." : "Drop workspace"}
          </button>
        </div>
      </dialog>
    </div>
  );
}

export function workspaceDisplayTitle(workspace: Workspace) {
  if (workspace.issueKey && workspace.issueTitle) {
    return `${workspace.issueTitle} (${workspace.name})`;
  }
  return workspace.name;
}

export function prToneFor(pr: PullRequestSummary | null | undefined): PrTone {
  if (!pr) return "missing";
  if (pr.state?.toLowerCase() === "merged") return "merged";
  if (pr.state?.toLowerCase() === "closed") return "missing";
  if (pr.mergeable === "conflicting" || pr.mergeStateStatus === "DIRTY") return "conflicting";
  const failed = pr.checks.some((check) =>
    ["failure", "cancelled", "timed_out", "action_required"].includes(String(check.conclusion ?? "").toLowerCase()),
  );
  if (failed) return "failing";
  const pending = pr.checks.some((check) =>
    ["queued", "in_progress", "pending"].includes(String(check.status).toLowerCase()),
  );
  if (pending) return "pending";
  if (pr.checks.length && pr.checks.every((check) => String(check.conclusion ?? "").toLowerCase() === "success")) {
    return "passing";
  }
  return "pending";
}

export function approvalToneFor(pr: PullRequestSummary | null | undefined): ApprovalTone {
  if (!pr) return "none";
  const decision = pr.reviewDecision?.toLowerCase() ?? "";
  if (decision.includes("approved")) return "approved";
  if (decision.includes("changes")) return "changes";
  if (decision.includes("review_required") || decision.includes("review-required")) return "pending";
  return "none";
}
