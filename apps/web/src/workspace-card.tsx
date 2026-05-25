import type { AgentSession, PullRequestSummary, Workspace } from "@citadel/contracts";
import { sessionNeedsAttention } from "@citadel/core";
import { useMutation } from "@tanstack/react-query";
import { GitBranch, Home, MessageSquare, ShieldAlert, ShieldCheck, ShieldQuestion, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, queryClient } from "./api.js";
import "./workspace-status-dot.css";

export type WorkspaceCardData = {
  workspace: Workspace;
  sessions: AgentSession[];
  pullRequest?: PullRequestSummary | null;
  approval?: ApprovalTone;
};

export type PrTone = "missing" | "pending" | "passing" | "failing" | "merged";
export type ApprovalTone = "none" | "pending" | "changes" | "approved";

export type WorkspaceAgentTone = "attention" | "running" | "idle";

// Aggregates the per-agent statuses for a workspace into one tone for the
// status dot. Priority: attention > running > idle. Shell sessions are
// excluded — they're plain terminals, not agents.
export function deriveWorkspaceAgentTone(sessions: AgentSession[]): WorkspaceAgentTone {
  const agentSessions = sessions.filter((s) => s.runtimeId !== "shell");
  if (agentSessions.some((s) => s.status === "waiting_for_input" || sessionNeedsAttention(s))) return "attention";
  if (agentSessions.some((s) => s.status === "starting" || s.status === "running")) return "running";
  return "idle";
}

// Maps the aggregated tone to the shared `cit-pulse-*` class used across
// the cockpit (bottom-bar "auto mode" pill, navigator "Running" stat,
// inspector deploy/runtime pulses). Keeps workspace-card chrome visually
// consistent with the rest of the app.
function citPulseClass(tone: WorkspaceAgentTone): string {
  if (tone === "attention") return "cit-pulse-bad";
  if (tone === "running") return "cit-pulse-run";
  return "cit-pulse-idle";
}

export function WorkspaceCard(props: WorkspaceCardData & { active: boolean; onSelect: () => void }) {
  const { workspace, pullRequest } = props;
  const titleDisplay = workspaceDisplayTitle(workspace);
  const prTone = pullRequest ? prToneFor(pullRequest) : "missing";
  const approvalTone = props.approval ?? approvalToneFor(pullRequest);
  const agentTone = deriveWorkspaceAgentTone(props.sessions);
  const agentToneSuffix =
    agentTone === "attention" ? ", agent needs attention" : agentTone === "running" ? ", agent running" : "";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(titleDisplay);
  const [confirmDrop, setConfirmDrop] = useState(false);
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

  return (
    <div className="workspace-card-wrap">
      <button
        type="button"
        className={`workspace-card ${props.active ? "active" : ""}`}
        onClick={() => {
          if (!editing) props.onSelect();
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
      {confirmDrop ? <DropWorkspaceDialog workspace={workspace} onClose={() => setConfirmDrop(false)} /> : null}
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
