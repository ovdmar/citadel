import type { PullRequestSummary, Repo, Workspace, WorkspaceSession, WorktreeCheckout } from "@citadel/contracts";
import { type PrTone, WorkspaceCard, approvalToneFor, prToneFor } from "./workspace-card.js";
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
  const workspaceForCard: Workspace = {
    ...props.workspace,
    repoId: props.checkout.repoId,
    branch: props.checkout.branch,
    baseBranch: props.checkout.baseBranch,
    kind: "worktree",
    issueKey: props.checkout.issue?.key ?? props.workspace.issueKey,
    issueTitle: props.checkout.issue?.title ?? props.workspace.issueTitle,
    issueUrl: props.checkout.issue?.url ?? props.workspace.issueUrl,
  };
  const prTone = props.pullRequest ? prToneFor(props.pullRequest) : checkoutPrTone(props.checkout);
  const branchLabel = checkoutBranchLabel(props.checkout, props.repo);
  const branchTitle = checkoutBranchTitle(props.checkout, props.repo);

  return (
    <div className="nav-checkout-card">
      <WorkspaceCard
        workspace={workspaceForCard}
        sessions={props.sessions}
        pullRequest={props.pullRequest}
        approval={props.pullRequest ? approvalToneFor(props.pullRequest) : "none"}
        namespace={null}
        active={props.active}
        onSelect={props.onSelect}
        branchLabel={branchLabel}
        branchTitle={branchTitle}
        cardTitle={branchTitle}
        prToneOverride={prTone}
        disableDrop
      />
    </div>
  );
}

export function checkoutBranchLabel(checkout: WorktreeCheckout, repo: Repo | null): string {
  return repo ? `${repo.name} · ${checkout.branch}` : checkout.branch;
}

export function checkoutBranchTitle(checkout: WorktreeCheckout, repo: Repo | null): string {
  const label = checkoutBranchLabel(checkout, repo);
  return `${label} · git worktree: ${checkout.name} · ${checkout.path}`;
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

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
