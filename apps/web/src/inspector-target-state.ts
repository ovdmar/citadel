import type { PullRequestSummary, Repo, Workspace, WorkspacePrStateEntry, WorktreeCheckout } from "@citadel/contracts";
import { checkoutPullRequest } from "./navigator-pr-state.js";

export type InspectorTargetState = {
  checkout: WorktreeCheckout | null;
  repo: Repo | null;
  pullRequest: PullRequestSummary | null;
  checkedAt: string | undefined;
  branch: string;
  baseBranch: string;
};

export function resolveInspectorTargetState(input: {
  workspace: Workspace;
  repos: readonly Repo[];
  checkouts: readonly WorktreeCheckout[];
  activeCheckoutId: string | null;
  workspacePullRequest: PullRequestSummary | null;
  workspaceCheckedAt: string | null | undefined;
  checkoutPrState: Map<string, WorkspacePrStateEntry> | null | undefined;
}): InspectorTargetState {
  const checkout = input.activeCheckoutId
    ? (input.checkouts.find((candidate) => candidate.id === input.activeCheckoutId) ?? null)
    : null;
  if (!checkout) {
    return {
      checkout: null,
      repo: input.workspace.repoId ? (input.repos.find((repo) => repo.id === input.workspace.repoId) ?? null) : null,
      pullRequest: input.workspacePullRequest,
      checkedAt: input.workspaceCheckedAt ?? undefined,
      branch: input.workspace.branch,
      baseBranch: input.workspace.baseBranch,
    };
  }

  const checkoutPrEntry = input.checkoutPrState?.get(checkout.id);
  return {
    checkout,
    repo: input.repos.find((repo) => repo.id === checkout.repoId) ?? null,
    pullRequest: checkoutPullRequest({
      checkout,
      workspacePullRequest: input.workspacePullRequest,
      checkoutPrState: input.checkoutPrState,
    }),
    checkedAt: checkoutPrEntry?.checkedAt ?? checkoutPrEntry?.cachedAt ?? undefined,
    branch: checkout.branch,
    baseBranch: checkout.baseBranch,
  };
}
