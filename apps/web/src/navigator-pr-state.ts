import type {
  PullRequestSummary,
  Workspace,
  WorkspaceCockpitSummary,
  WorkspacePrStateEntry,
  WorkspaceSession,
  WorktreeCheckout,
} from "@citadel/contracts";
import type { LifecycleTone } from "@citadel/core";
import {
  type AttentionSessionIds,
  deriveWorkspaceDisplayLifecycleTone,
  workspaceCardSessions,
} from "./session-status-display.js";
import { type ApprovalTone, type PrTone, approvalToneFor, prToneFor } from "./workspace-card.js";

export type CheckoutPrStateByWorkspace = Map<string, Map<string, WorkspacePrStateEntry>>;

export type WorkspacePrAggregate = {
  prTone: PrTone;
  approval: ApprovalTone;
  additions: number | null;
  deletions: number | null;
  prCount: number;
};

/**
 * Resolve which PR summary to show for a workspace in the navigator.
 * Precedence:
 *   1. Active workspace: prefer activeSummary.versionControl.pullRequest
 *      (10s cadence via useWorkspaceCockpitSummary).
 *   2. Else: workspacesPrState[id]?.pullRequest (30s cadence + focus
 *      invalidation via useWorkspacesPrState).
 *   3. Else: null (grey "no PR" pill).
 *
 * Deliberately does NOT consult queryClient.getQueryData for other
 * workspaces' cockpit-summary caches — that would be a non-subscribing
 * read inside render, silently re-introducing a freshness regression for
 * non-active workspaces. The 30s pr-state poll + on-focus invalidation
 * is the freshness contract for non-active workspaces.
 */
export function resolveWorkspacePullRequest(input: {
  workspaceId: string;
  activeSummary: WorkspaceCockpitSummary | null | undefined;
  workspacesPrState: Record<string, WorkspacePrStateEntry>;
}): PullRequestSummary | null {
  const { workspaceId, activeSummary, workspacesPrState } = input;
  if (activeSummary && activeSummary.workspaceId === workspaceId) {
    return activeSummary.versionControl.pullRequest ?? null;
  }
  return workspacesPrState[workspaceId]?.pullRequest ?? null;
}

export function aggregateNavigatorTone(
  workspaces: Workspace[],
  sessions: WorkspaceSession[],
  prByWorkspaceId?: Map<string, PullRequestSummary | null>,
  checkouts: WorktreeCheckout[] = [],
  checkoutPrByWorkspaceId?: CheckoutPrStateByWorkspace,
  unseenAttentionSessionIds?: AttentionSessionIds,
): LifecycleTone {
  let aggregate: LifecycleTone = "never-started";
  for (const workspace of workspaces) {
    const workspaceCheckouts = checkouts.filter(
      (checkout) => checkout.workspaceId === workspace.id && !checkout.archivedAt,
    );
    if (workspaceCheckouts.length) {
      const prAggregate = aggregateWorkspacePrState({
        checkouts: workspaceCheckouts,
        workspacePullRequest: prByWorkspaceId?.get(workspace.id) ?? null,
        checkoutPrState: checkoutPrByWorkspaceId?.get(workspace.id),
      });
      if (prAggregate.prTone === "conflicting" || prAggregate.prTone === "failing") return "attention";
    }
    const tone = deriveWorkspaceDisplayLifecycleTone({
      sessions: workspaceCardSessions(sessions, workspace.id, workspaceCheckouts),
      pullRequest: prByWorkspaceId?.get(workspace.id) ?? null,
      unseenAttentionSessionIds,
    });
    if (tone === "attention") return "attention";
    if (tone === "running") aggregate = "running";
    else if (tone === "done" && aggregate === "never-started") aggregate = "done";
  }
  return aggregate;
}

export function checkoutPrStateMap(
  state: Record<string, Record<string, WorkspacePrStateEntry>> | null | undefined,
): CheckoutPrStateByWorkspace {
  const map: CheckoutPrStateByWorkspace = new Map();
  for (const [workspaceId, entries] of Object.entries(state ?? {})) {
    map.set(workspaceId, new Map(Object.entries(entries)));
  }
  return map;
}

export function checkoutPullRequest(input: {
  checkout: WorktreeCheckout;
  workspacePullRequest: PullRequestSummary | null;
  checkoutPrState: Map<string, WorkspacePrStateEntry> | null | undefined;
}): PullRequestSummary | null {
  const entry = input.checkoutPrState?.get(input.checkout.id);
  if (entry?.pullRequest) return entry.pullRequest;
  return pullRequestMatchesCheckout(input.workspacePullRequest, input.checkout) ? input.workspacePullRequest : null;
}

export function aggregateWorkspacePrState(input: {
  checkouts: readonly WorktreeCheckout[];
  workspacePullRequest: PullRequestSummary | null;
  checkoutPrState: Map<string, WorkspacePrStateEntry> | null | undefined;
}): WorkspacePrAggregate {
  const tones: PrTone[] = [];
  const approvals: ApprovalTone[] = [];
  const keys = new Set<string>();
  let additions = 0;
  let deletions = 0;
  let hasDiff = false;
  let expectedPrCount = 0;

  for (const checkout of input.checkouts) {
    const pullRequest = checkoutPullRequest({
      checkout,
      workspacePullRequest: input.workspacePullRequest,
      checkoutPrState: input.checkoutPrState,
    });
    const hasExpectedPr = Boolean(pullRequest || hasIntendedPullRequestIdentity(checkout));
    if (hasExpectedPr) expectedPrCount += 1;
    tones.push(pullRequest ? prToneFor(pullRequest) : intendedPrTone());
    if (pullRequest) {
      keys.add(pullRequest.url || `checkout-pr-${pullRequest.number}`);
      approvals.push(approvalToneFor(pullRequest));
      if (pullRequest.additions !== null || pullRequest.deletions !== null) {
        hasDiff = true;
        additions += pullRequest.additions ?? 0;
        deletions += pullRequest.deletions ?? 0;
      }
    } else if (hasIntendedPullRequestIdentity(checkout)) {
      keys.add(checkout.intendedPr.url ?? `${checkout.id}:${checkout.intendedPr.number ?? "unknown"}`);
      approvals.push("pending");
    }
  }

  if (input.checkouts.length === 0 && input.workspacePullRequest) {
    tones.push(prToneFor(input.workspacePullRequest));
    approvals.push(approvalToneFor(input.workspacePullRequest));
    keys.add(input.workspacePullRequest.url || `workspace-pr-${input.workspacePullRequest.number}`);
    if (input.workspacePullRequest.additions !== null || input.workspacePullRequest.deletions !== null) {
      hasDiff = true;
      additions += input.workspacePullRequest.additions ?? 0;
      deletions += input.workspacePullRequest.deletions ?? 0;
    }
  }

  return {
    prTone: aggregatePrTone(tones),
    approval: aggregateApprovalTone(approvals, expectedPrCount),
    additions: hasDiff ? additions : null,
    deletions: hasDiff ? deletions : null,
    prCount: keys.size,
  };
}

function aggregatePrTone(tones: readonly PrTone[]): PrTone {
  for (const tone of ["conflicting", "failing", "pending", "passing", "merged"] as const) {
    if (tones.includes(tone)) return tone;
  }
  return "missing";
}

function aggregateApprovalTone(approvals: readonly ApprovalTone[], expectedPrCount: number): ApprovalTone {
  if (!expectedPrCount) return "none";
  if (approvals.includes("changes")) return "changes";
  if (approvals.length === expectedPrCount && approvals.every((tone) => tone === "approved")) return "approved";
  if (approvals.some((tone) => tone === "pending" || tone === "approved" || tone === "none")) return "pending";
  return "none";
}

function intendedPrTone(): PrTone {
  return "missing";
}

function pullRequestMatchesCheckout(
  pullRequest: PullRequestSummary | null,
  checkout: WorktreeCheckout,
): pullRequest is PullRequestSummary {
  if (!pullRequest || !hasIntendedPullRequestIdentity(checkout)) return false;
  if (checkout.intendedPr.url && checkout.intendedPr.url === pullRequest.url) return true;
  return Boolean(checkout.intendedPr.number && checkout.intendedPr.number === pullRequest.number);
}

export function hasIntendedPullRequestIdentity(checkout: Pick<WorktreeCheckout, "intendedPr">): checkout is Pick<
  WorktreeCheckout,
  "intendedPr"
> & {
  intendedPr: NonNullable<WorktreeCheckout["intendedPr"]>;
} {
  return Boolean(checkout.intendedPr?.number || checkout.intendedPr?.url);
}
