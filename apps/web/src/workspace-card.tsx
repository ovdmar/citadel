import type { AgentSession, Namespace, PullRequestSummary, Workspace } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import {
  Bot,
  CircleDot,
  ExternalLink,
  Folder,
  GitPullRequest,
  Hash,
  Home,
  Loader2,
  MessageSquare,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, queryClient } from "./api.js";
import { useStateQuery } from "./app-state.js";

export type WorkspaceCardData = {
  workspace: Workspace;
  sessions: AgentSession[];
  pullRequest?: PullRequestSummary | null;
  approval?: ApprovalTone;
  // When provided, skip the global state lookup and use this directly. Callers
  // rendering many cards should build a Map once at the parent and pass the
  // entry per workspace to avoid O(n*m) lookups across a large list.
  namespace?: Namespace | null;
  namespaces?: Namespace[];
};

export type PrTone = "missing" | "pending" | "passing" | "failing" | "merged";
export type ApprovalTone = "none" | "pending" | "changes" | "approved";

export function WorkspaceCard(
  props: WorkspaceCardData & { active: boolean; onSelect: () => void; draggable?: boolean },
) {
  const { workspace, sessions, pullRequest } = props;
  const titleDisplay = workspaceDisplayTitle(workspace);
  const agentState = deriveAgentState(sessions);
  const prTone = pullRequest ? prToneFor(pullRequest) : "missing";
  const approvalTone = props.approval ?? approvalToneFor(pullRequest);
  const additions = pullRequest?.additions ?? null;
  const deletions = pullRequest?.deletions ?? null;
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

  // Drag payload: the workspace id, so namespace drop targets can reassign it
  // via /api/namespaces/assign. Opt-in per call site (only the nav/dashboard
  // namespace views enable it) to avoid accidental drags elsewhere.
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
        aria-label={`Open workspace ${workspace.name}`}
      >
        <span
          className={`workspace-card-agent ${agentState.tone} ${workspace.kind === "root" ? "root" : ""}`}
          title={workspace.kind === "root" ? "Repository root workspace" : agentState.label}
        >
          {workspace.kind === "root" ? (
            <Home size={14} />
          ) : agentState.tone === "starting" || agentState.tone === "running" ? (
            <Loader2 size={14} style={{ animation: "spin 1.4s linear infinite" }} />
          ) : (
            <Bot size={14} />
          )}
        </span>
        <span className="workspace-card-main">
          <span className="workspace-card-title">
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
          {workspace.slackThreadUrl ? (
            <a
              href={workspace.slackThreadUrl}
              target="_blank"
              rel="noreferrer"
              className="linked-pill"
              title="Open linked Slack thread"
              onClick={(event) => event.stopPropagation()}
            >
              <MessageSquare size={11} />
            </a>
          ) : null}
          {workspace.issueUrl ? (
            <a
              href={workspace.issueUrl}
              target="_blank"
              rel="noreferrer"
              className="linked-pill"
              title={workspace.issueKey ? `Open ${workspace.issueKey}` : "Open linked issue"}
              onClick={(event) => event.stopPropagation()}
            >
              {workspace.issueKey ? <Hash size={11} /> : <ExternalLink size={11} />}
            </a>
          ) : null}
          {additions !== null || deletions !== null ? (
            <span className="workspace-card-diff">
              <span className="diff-add">+{additions ?? 0}</span>
              <span className="diff-del">-{deletions ?? 0}</span>
            </span>
          ) : null}
          {pullRequest ? (
            <a
              href={pullRequest.url}
              target="_blank"
              rel="noreferrer"
              className={`pr-pill tone-${prTone}`}
              title={`PR #${pullRequest.number} · ${prTone}`}
              onClick={(event) => event.stopPropagation()}
            >
              <GitPullRequest size={11} />
            </a>
          ) : (
            <span className="pr-pill" title="No PR yet">
              <GitPullRequest size={11} />
            </span>
          )}
          <span className={`approval-pill tone-${approvalTone}`} title={`Approval: ${approvalTone}`}>
            {approvalTone === "approved" ? (
              <ShieldCheck size={11} />
            ) : approvalTone === "changes" ? (
              <ShieldAlert size={11} />
            ) : approvalTone === "pending" ? (
              <MessageSquare size={11} />
            ) : (
              <ShieldQuestion size={11} />
            )}
          </span>
          {workspace.dirty ? <span className="workspace-card-dirty" title="Uncommitted changes" /> : null}
          {agentState.tone === "failed" ? <CircleDot size={10} color="var(--color-danger)" /> : null}
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

function NamespacePickerDialog(props: { workspace: Workspace; namespaces: Namespace[]; onClose: () => void }) {
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
          <button
            type="button"
            className="check-row"
            onClick={() => assign.mutate(null)}
            disabled={!props.workspace.namespaceId || assign.isPending}
          >
            Uncategorized
          </button>
          {props.namespaces.map((namespace) => (
            <button
              key={namespace.id}
              type="button"
              className="check-row"
              onClick={() => assign.mutate(namespace.id)}
              disabled={props.workspace.namespaceId === namespace.id || assign.isPending}
            >
              {namespace.name}
            </button>
          ))}
          {!props.namespaces.length ? (
            <div className="empty compact">No namespaces yet. Create one from the dashboard.</div>
          ) : null}
        </div>
        <div className="drop-workspace-actions">
          <button type="button" className="drop-workspace-cancel" onClick={props.onClose}>
            Cancel
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

function deriveAgentState(sessions: AgentSession[]): {
  tone: "running" | "starting" | "stopped" | "failed";
  label: string;
} {
  const agentSessions = sessions.filter((session) => session.runtimeId !== "shell");
  if (agentSessions.some((session) => session.status === "starting"))
    return { tone: "starting", label: "Agent starting" };
  if (agentSessions.some((session) => session.status === "waiting")) return { tone: "running", label: "Agent working" };
  if (agentSessions.some((session) => ["failed", "orphaned"].includes(session.status))) {
    return { tone: "failed", label: "Agent needs attention" };
  }
  if (agentSessions.length) return { tone: "stopped", label: "Agent stopped" };
  if (sessions.length) return { tone: "stopped", label: "Terminal session" };
  return { tone: "stopped", label: "No session" };
}

export function prToneFor(pr: PullRequestSummary | null | undefined): PrTone {
  if (!pr) return "missing";
  if (pr.state?.toLowerCase() === "merged") return "merged";
  if (pr.state?.toLowerCase() === "closed") return "missing";
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
