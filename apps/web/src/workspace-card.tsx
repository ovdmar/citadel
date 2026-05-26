import type { AgentSession, Namespace, PullRequestSummary, Workspace } from "@citadel/contracts";
import { sessionNeedsAttention } from "@citadel/core";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowUp,
  Copy,
  ExternalLink,
  Folder,
  GitBranch,
  Home,
  MessageSquare,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, queryClient } from "./api.js";
import { useStateQuery } from "./app-state.js";
import { PrCardActionSlot } from "./pr-card-actions.js";
import "./workspace-status-dot.css";

export type WorkspaceCardData = {
  workspace: Workspace;
  sessions: AgentSession[];
  pullRequest?: PullRequestSummary | null;
  approval?: ApprovalTone;
  // When provided, skip the global state lookup and use these directly.
  // Callers rendering many cards should build the namespace Map once at the
  // parent so we avoid O(n*m) lookups across a large list.
  namespace?: Namespace | null;
  namespaces?: Namespace[];
};

export type PrTone = "missing" | "pending" | "passing" | "failing" | "merged" | "conflicting";
export type ApprovalTone = "none" | "pending" | "changes" | "approved";

export type WorkspaceAgentTone = "attention" | "rate_limited" | "running" | "idle";

// Aggregates the per-agent statuses for a workspace into one tone for the
// status dot. Priority: attention > rate_limited > running > idle. Shell
// sessions are excluded — they're plain terminals, not agents. usage_limited
// (account-wide cap, waits for a known reset) collapses into the same blue
// `rate_limited` tone since both mean "stalled, will recover".
export function deriveWorkspaceAgentTone(sessions: AgentSession[]): WorkspaceAgentTone {
  const agentSessions = sessions.filter((s) => s.runtimeId !== "shell");
  if (agentSessions.some((s) => s.status === "waiting_for_input" || sessionNeedsAttention(s))) return "attention";
  if (agentSessions.some((s) => s.status === "rate_limited" || s.status === "usage_limited")) return "rate_limited";
  if (agentSessions.some((s) => s.status === "starting" || s.status === "running")) return "running";
  return "idle";
}

// Maps the aggregated tone to the shared `cit-pulse-*` class used across
// the cockpit (bottom-bar "auto mode" pill, navigator "Running" stat,
// inspector deploy/runtime pulses). Keeps workspace-card chrome visually
// consistent with the rest of the app.
function citPulseClass(tone: WorkspaceAgentTone): string {
  if (tone === "attention") return "cit-pulse-bad";
  if (tone === "rate_limited") return "cit-pulse-info";
  if (tone === "running") return "cit-pulse-run";
  return "cit-pulse-idle";
}

export function WorkspaceCard(
  props: WorkspaceCardData & { active: boolean; onSelect: () => void; draggable?: boolean },
) {
  const { workspace, pullRequest } = props;
  const titleDisplay = workspaceDisplayTitle(workspace);
  const prTone = pullRequest ? prToneFor(pullRequest) : "missing";
  const approvalTone = props.approval ?? approvalToneFor(pullRequest);
  const agentTone = deriveWorkspaceAgentTone(props.sessions);
  const agentToneSuffix =
    agentTone === "attention" ? ", agent needs attention" : agentTone === "running" ? ", agent running" : "";
  const additions = pullRequest?.additions ?? null;
  const deletions = pullRequest?.deletions ?? null;
  const hasDiff = additions !== null || deletions !== null;

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
    mutationFn: (name: string) =>
      api(`/api/workspaces/${workspace.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["state"] });
    },
  });

  // Drag payload: workspace id, so namespace drop targets in the nav and
  // dashboard can reassign via /api/namespaces/assign. Opt-in so accidental
  // drags elsewhere stay no-ops.
  const dragHandlers = props.draggable
    ? {
        draggable: true,
        onDragStart: (event: React.DragEvent) => {
          event.dataTransfer.setData("application/x-citadel-workspace-id", workspace.id);
          event.dataTransfer.effectAllowed = "move";
        },
      }
    : {};
  return (
    <div className="workspace-card-wrap" {...dragHandlers}>
      <button
        type="button"
        className={`workspace-card ${props.active ? "active" : ""}`}
        onClick={() => {
          if (!editing) props.onSelect();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setShowNamespaceMenu(true);
        }}
        aria-label={`Open workspace ${workspace.name}${agentToneSuffix}`}
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
              className={`cit-pulse cit-pulse-sm ${citPulseClass(agentTone)} workspace-status-dot`}
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
                aria-label="Rename workspace"
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
          <span className="workspace-card-branch" title={workspace.branch}>
            {workspace.branch}
          </span>
        </span>
        <span className="workspace-card-right" aria-hidden>
          {namespace ? (
            <span
              className="namespace-pill"
              title={`Namespace: ${namespace.name}`}
              style={namespace.color ? { background: namespace.color, color: "#fff" } : undefined}
            >
              <Folder size={10} /> {namespace.name}
            </span>
          ) : null}
          {hasDiff ? (
            <span className="workspace-card-diff" title="Lines changed in this PR">
              <span className="diff-add">+{additions ?? 0}</span>
              <span className="diff-del">-{deletions ?? 0}</span>
            </span>
          ) : null}
          <span className={`approval-pill tone-${approvalTone}`} title={`Approval: ${approvalTone}`}>
            {approvalTone === "approved" ? (
              <ShieldCheck size={13} />
            ) : approvalTone === "changes" ? (
              <ShieldAlert size={13} />
            ) : approvalTone === "pending" ? (
              <MessageSquare size={13} />
            ) : (
              <ShieldQuestion size={13} />
            )}
          </span>
        </span>
      </button>
      {workspace.kind === "root" ? null : (
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
      {workspace.kind === "root" ? null : (
        <WorkspaceCardPrStrip workspace={workspace} pullRequest={pullRequest ?? null} prTone={prTone} />
      )}
      {confirmDrop ? <DropWorkspaceDialog workspace={workspace} onClose={() => setConfirmDrop(false)} /> : null}
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

// Always-visible PR strip below the card body. Shows the placeholder when no
// PR exists so the lifecycle slot stays visible on every workspace; renders
// the PR identity (with copy-head-branch + open-in-new-tab) when one is
// attached. Stacked PRs surface as a parent chip above the title row.
function WorkspaceCardPrStrip(props: {
  workspace: Workspace;
  pullRequest: PullRequestSummary | null;
  prTone: PrTone;
}) {
  const { workspace, pullRequest, prTone } = props;
  const stop = (event: React.MouseEvent) => event.stopPropagation();
  if (!pullRequest) {
    return (
      <div className="workspace-card-pr workspace-card-pr-empty" aria-label="No PR for this workspace">
        <span className="workspace-card-pr-dash" aria-hidden>
          —
        </span>
        <span>No PR</span>
      </div>
    );
  }
  // Copy the PR's head ref, not workspace.branch — they can diverge if the
  // local branch was renamed after the PR was opened.
  const headRef = pullRequest.headRefName ?? workspace.branch;
  const copyHead = (event: React.MouseEvent) => {
    event.stopPropagation();
    if (typeof navigator !== "undefined" && navigator.clipboard) navigator.clipboard.writeText(headRef);
  };
  return (
    <div className="workspace-card-pr" data-tone={prTone}>
      {pullRequest.parentPr ? (
        <a
          className="workspace-card-pr-parent"
          href={pullRequest.parentPr.url}
          target="_blank"
          rel="noreferrer"
          onClick={stop}
          data-state={pullRequest.parentPr.state.toLowerCase() === "merged" ? "merged" : "open"}
          title={`Parent PR #${pullRequest.parentPr.number} (${pullRequest.parentPr.state})`}
        >
          <ArrowUp size={9} /> #{pullRequest.parentPr.number}
        </a>
      ) : null}
      <div className="workspace-card-pr-row workspace-card-pr-title-row">
        <a
          className="workspace-card-pr-title"
          href={pullRequest.url}
          target="_blank"
          rel="noreferrer"
          onClick={stop}
          title={pullRequest.title}
        >
          #{pullRequest.number}: {pullRequest.title}
        </a>
        <a
          className="workspace-card-pr-open"
          href={pullRequest.url}
          target="_blank"
          rel="noreferrer"
          onClick={stop}
          aria-label={`Open PR #${pullRequest.number} in a new tab`}
          title="Open PR in a new tab"
        >
          <ExternalLink size={10} />
        </a>
      </div>
      <div className="workspace-card-pr-row workspace-card-pr-branch-row">
        <span className={`workspace-card-pr-chip tone-${prTone}`} title={`PR state: ${prTone}`}>
          {prTone}
        </span>
        <span className="workspace-card-pr-base">
          <span className="workspace-card-pr-mono">{workspace.baseBranch}</span>
          <span className="workspace-card-pr-arrow">←</span>
          <span className="workspace-card-pr-mono">{headRef}</span>
        </span>
        <button
          type="button"
          className="workspace-card-pr-copy"
          onClick={copyHead}
          aria-label={`Copy head branch ${headRef}`}
          title={`Copy head branch ${headRef}`}
        >
          <Copy size={10} />
        </button>
        <PrCardActionSlot workspace={workspace} pr={pullRequest} prTone={prTone} />
      </div>
    </div>
  );
}

function NamespacePickerDialog(props: { workspace: Workspace; namespaces: Namespace[]; onClose: () => void }) {
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
};

function DropWorkspaceDialog(props: { workspace: Workspace; onClose: () => void }) {
  const drop = useMutation({
    mutationFn: async (): Promise<DropResult> => {
      const response = await fetch(`/api/workspaces/${props.workspace.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
      });
      const body = (await response.json().catch(() => ({}))) as Partial<DropResult> & { error?: string };
      return {
        removed: Boolean(body.removed),
        archived: Boolean(body.archived),
        dirty: Boolean(body.dirty),
        error: body.error ?? null,
      };
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      if (result.removed) props.onClose();
    },
  });
  const result = drop.data;
  const dirtyBlocked = Boolean(result && !result.removed && result.dirty);
  const teardownBlocked = Boolean(result && !result.removed && !result.dirty);
  return (
    <div className="drop-workspace-backdrop" onMouseDown={props.onClose}>
      <dialog
        className="drop-workspace-dialog"
        aria-label={`Drop workspace ${props.workspace.name}`}
        open
        onMouseDown={(event) => event.stopPropagation()}
      >
        <strong>Drop "{props.workspace.name}"?</strong>
        <p>
          This runs the repo's teardown hook (if any) and removes the git worktree. Deletion is blocked if the worktree
          has uncommitted changes or unpushed commits.
        </p>
        {dirtyBlocked ? (
          <p className="drop-workspace-error">
            Workspace has uncommitted changes or unpushed commits. Commit and push before dropping.
          </p>
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
            disabled={drop.isPending || dirtyBlocked}
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
