import type { PullRequestSummary, WorkspaceCockpitSummary, WorkspacePrStateEntry } from "@citadel/contracts";

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
