import type { AgentSession, PullRequestSummary, Workspace } from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import {
  Bot,
  CircleDot,
  GitPullRequest,
  Loader2,
  MessageSquare,
  ShieldAlert,
  ShieldCheck,
  ShieldQuestion,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, queryClient } from "./api.js";

export type WorkspaceCardData = {
  workspace: Workspace;
  sessions: AgentSession[];
  pullRequest?: PullRequestSummary | null;
  approval?: ApprovalTone;
};

export type PrTone = "missing" | "pending" | "passing" | "failing" | "merged";
export type ApprovalTone = "none" | "pending" | "changes" | "approved";

export function WorkspaceCard(props: WorkspaceCardData & { active: boolean; onSelect: () => void }) {
  const { workspace, sessions, pullRequest } = props;
  const titleDisplay = workspaceDisplayTitle(workspace);
  const agentState = deriveAgentState(sessions);
  const prTone = pullRequest ? prToneFor(pullRequest) : "missing";
  const approvalTone = props.approval ?? approvalToneFor(pullRequest);
  const additions = pullRequest?.additions ?? null;
  const deletions = pullRequest?.deletions ?? null;

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(titleDisplay);
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
    <button
      type="button"
      className={`workspace-card ${props.active ? "active" : ""}`}
      onClick={() => {
        if (!editing) props.onSelect();
      }}
      aria-label={`Open workspace ${workspace.name}`}
    >
      <span className={`workspace-card-agent ${agentState.tone}`} title={agentState.label}>
        {agentState.tone === "starting" || agentState.tone === "running" ? (
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
  if (agentSessions.some((session) => session.status === "running")) return { tone: "running", label: "Agent running" };
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
