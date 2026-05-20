import type { AgentSession, PullRequestSummary, Workspace } from "@citadel/contracts";
import { GitBranch, GitPullRequest, Pin, Sparkles, Square, TerminalSquare } from "lucide-react";
import type { WorkspaceAttention } from "./cockpit-readiness.js";

type PrTone = "missing" | "draft" | "open" | "pending" | "passing" | "failing" | "merged";

export function WorkspaceCard(props: {
  workspace: Workspace;
  sessions: AgentSession[];
  attention: WorkspaceAttention;
  active: boolean;
  pullRequest?: PullRequestSummary | null;
  onSelect: () => void;
}) {
  const { workspace, sessions, attention } = props;
  const activeSessions = sessions.filter((session) => ["running", "waiting", "idle"].includes(session.status));
  const failedSession = sessions.some((session) => ["failed", "orphaned"].includes(session.status));
  const prTone: PrTone = workspace.prUrl ? prToneFor(props.pullRequest) : "missing";
  const additions = props.pullRequest?.additions ?? null;
  const deletions = props.pullRequest?.deletions ?? null;
  return (
    <button
      type="button"
      className={`workspace-card ${props.active ? "active" : ""}`}
      onClick={props.onSelect}
      aria-label={`Open workspace ${workspace.name}`}
    >
      <span className={`attention-dot tone-${attention.tone}`} aria-hidden />
      <span className="workspace-card-main">
        <span className="workspace-card-title">
          {workspace.pinned ? <Pin size={11} className="workspace-card-pin" aria-label="Pinned" /> : null}
          <strong>{workspace.name}</strong>
        </span>
        <span className="workspace-card-branch">
          <GitBranch size={11} aria-hidden />
          <span>{workspace.branch}</span>
        </span>
        <small className="workspace-card-attention">{attention.nextAction}</small>
      </span>
      <span className="workspace-card-icons" aria-hidden>
        {workspace.issueKey ? <span className="workspace-card-issue">{workspace.issueKey}</span> : null}
        {workspace.prUrl ? (
          <span className={`workspace-card-pr pr-${prTone}`} title={`PR ${prTone}`}>
            <GitPullRequest size={12} />
            {props.pullRequest?.number ? <span>#{props.pullRequest.number}</span> : null}
            {props.pullRequest?.state ? <span>{props.pullRequest.state}</span> : null}
            {additions !== null || deletions !== null ? (
              <em className="workspace-card-diff">
                <span className="diff-add">+{additions ?? 0}</span>
                <span className="diff-del">-{deletions ?? 0}</span>
              </em>
            ) : null}
          </span>
        ) : null}
        {workspace.dirty ? (
          <span className="workspace-card-dirty" title="Uncommitted changes">
            ●
          </span>
        ) : null}
        {activeSessions.length ? (
          <span className="workspace-card-sessions" title={`${activeSessions.length} active sessions`}>
            <Sparkles size={11} />
            {activeSessions.length}
          </span>
        ) : sessions.length ? (
          <span className="workspace-card-sessions inactive" title={`${sessions.length} sessions, none active`}>
            <Square size={10} />
            {sessions.length}
          </span>
        ) : (
          <span className="workspace-card-sessions empty" title="No sessions">
            <TerminalSquare size={11} />
          </span>
        )}
        {failedSession ? (
          <span className="workspace-card-failed" title="Failed session">
            !
          </span>
        ) : null}
      </span>
    </button>
  );
}

function prToneFor(pr: PullRequestSummary | null | undefined): PrTone {
  if (!pr) return "open";
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
  const allPassing =
    pr.checks.length > 0 && pr.checks.every((check) => String(check.conclusion ?? "").toLowerCase() === "success");
  if (allPassing) return "passing";
  if (pr.draft) return "draft";
  return "open";
}
