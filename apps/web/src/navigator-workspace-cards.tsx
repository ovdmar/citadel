import type { PullRequestSummary, Repo, Workspace, WorkspaceSession, WorktreeCheckout } from "@citadel/contracts";
import { deriveWorkspaceLifecycleTone } from "@citadel/core";
import { GitBranch, MessageSquare, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { type ApprovalTone, type PrTone, approvalToneFor, lifecycleToneClass, prToneFor } from "./workspace-card.js";
import "./navigator-workspace-cards.css";

type CheckoutNavCardProps = {
  workspace: Workspace;
  checkout: WorktreeCheckout;
  repo: Repo | null;
  sessions: WorkspaceSession[];
  pullRequest: PullRequestSummary | null;
  active: boolean;
  onSelect: () => void;
};

export function hasNestedCheckouts(checkouts: readonly WorktreeCheckout[]): boolean {
  return checkouts.length > 0;
}

export function workspaceAggregateBranchLabel(input: {
  checkouts: readonly WorktreeCheckout[];
  sessions: readonly WorkspaceSession[];
  pullRequest: PullRequestSummary | null;
}): string {
  const repoCount = new Set(input.checkouts.map((checkout) => checkout.repoId)).size;
  const prCount = aggregatePrCount(input.checkouts, input.pullRequest);
  const sessionCount = input.sessions.filter((session) => !session.closedAt).length;
  return [
    plural(repoCount, "repo"),
    plural(input.checkouts.length, "worktree"),
    plural(prCount, "PR"),
    plural(sessionCount, "session"),
  ].join(" · ");
}

export function checkoutSessions(sessions: readonly WorkspaceSession[], checkoutId: string): WorkspaceSession[] {
  return sessions.filter((session) => !session.closedAt && session.checkoutId === checkoutId);
}

export function pullRequestForCheckout(
  pullRequest: PullRequestSummary | null,
  checkout: WorktreeCheckout,
): PullRequestSummary | null {
  if (!pullRequest || !checkout.intendedPr) return null;
  if (checkout.intendedPr.url && checkout.intendedPr.url === pullRequest.url) return pullRequest;
  if (checkout.intendedPr.number && checkout.intendedPr.number === pullRequest.number) return pullRequest;
  return null;
}

export function CheckoutNavCard(props: CheckoutNavCardProps) {
  const title = props.repo
    ? props.repo.name === props.checkout.name
      ? props.repo.name
      : `${props.repo.name} · ${props.checkout.name}`
    : props.checkout.name;
  const prTone = props.pullRequest ? prToneFor(props.pullRequest) : checkoutPrTone(props.checkout);
  const approvalTone = props.pullRequest ? approvalToneFor(props.pullRequest) : "none";
  const lifecycleTone = deriveWorkspaceLifecycleTone({
    sessions: props.sessions,
    pullRequest: props.pullRequest,
  });
  const prLabel = checkoutPrLabel(props.checkout, props.pullRequest);
  const hasDiff = props.pullRequest
    ? props.pullRequest.additions !== null || props.pullRequest.deletions !== null
    : false;

  return (
    <button
      type="button"
      className={`workspace-card nav-checkout-card ${props.active ? "active" : ""}`}
      data-cit-on-dark={props.active ? "true" : undefined}
      onClick={props.onSelect}
      aria-label={`Open ${title}`}
      title={props.checkout.path}
    >
      <span className={`workspace-card-agent tone-${prTone}`} title={prLabel ?? undefined}>
        <GitBranch size={14} />
      </span>
      <span className="workspace-card-main">
        <span className="workspace-card-title">
          <span
            className={`cit-pulse cit-pulse-sm ${lifecycleToneClass(lifecycleTone)} workspace-status-dot`}
            aria-hidden="true"
          />
          <strong title={title}>
            {props.checkout.issue?.key ? (
              <span className="workspace-card-issue">{props.checkout.issue.key}</span>
            ) : null}
            {title}
          </strong>
        </span>
        <span className="workspace-card-branch" title={props.checkout.branch}>
          {props.checkout.branch}
        </span>
      </span>
      <span className="workspace-card-right" aria-hidden>
        {hasDiff ? (
          <span className="workspace-card-diff" title="Lines changed in this PR">
            <span className="diff-add">+{props.pullRequest?.additions ?? 0}</span>
            <span className="diff-del">-{props.pullRequest?.deletions ?? 0}</span>
          </span>
        ) : prLabel ? (
          <span className="workspace-card-diff" title={prLabel}>
            {prLabel}
          </span>
        ) : null}
        <ApprovalIcon tone={approvalTone} />
      </span>
    </button>
  );
}

function aggregatePrCount(checkouts: readonly WorktreeCheckout[], pullRequest: PullRequestSummary | null): number {
  const keys = new Set<string>();
  if (pullRequest) keys.add(pullRequest.url || `workspace-pr-${pullRequest.number}`);
  for (const checkout of checkouts) {
    if (!checkout.intendedPr) continue;
    keys.add(checkout.intendedPr.url ?? `${checkout.id}:${checkout.intendedPr.number ?? "unknown"}`);
  }
  return keys.size;
}

function checkoutPrTone(checkout: WorktreeCheckout): PrTone {
  if (!checkout.intendedPr) return "missing";
  if (checkout.intendedPr.hasConflicts) return "conflicting";
  if (checkout.intendedPr.checksGreen === true) return "passing";
  if (checkout.intendedPr.checksGreen === false) return "failing";
  return "pending";
}

export function checkoutPrLabel(checkout: WorktreeCheckout, pullRequest: PullRequestSummary | null): string | null {
  if (pullRequest) return `PR #${pullRequest.number}`;
  return checkout.intendedPr?.number ? `PR #${checkout.intendedPr.number}` : null;
}

function ApprovalIcon(props: { tone: ApprovalTone }) {
  return (
    <span className={`approval-pill tone-${props.tone}`} title={`Approval: ${props.tone}`}>
      {props.tone === "approved" ? (
        <ShieldCheck size={13} />
      ) : props.tone === "changes" ? (
        <ShieldAlert size={13} />
      ) : props.tone === "pending" ? (
        <MessageSquare size={13} />
      ) : (
        <ShieldQuestion size={13} />
      )}
    </span>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
