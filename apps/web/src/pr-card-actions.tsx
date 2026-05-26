import type { ProviderHealth, PullRequestSummary, Workspace } from "@citadel/contracts";
import type { PrMergeStrategy } from "@citadel/contracts/pr-routes";
import { useMutation, useQuery } from "@tanstack/react-query";
import { GitMerge, GitPullRequest, Loader2 } from "lucide-react";
import { useState } from "react";
import { api, queryClient } from "./api.js";
import type { PrTone } from "./workspace-card.js";

// Decides which (single) action button belongs in the PR card's bottom-right
// action slot. Fix conflicts and Merge are mutually exclusive by design —
// you can't merge a PR that has conflicts, and the only useful action on a
// conflicting PR is to launch an agent to resolve them. Merged/closed PRs
// have no actionable next step here, so the slot renders nothing.
export function PrCardActionSlot(props: { workspace: Workspace; pr: PullRequestSummary; prTone: PrTone }) {
  const { workspace, pr, prTone } = props;
  if (prTone === "merged" || prTone === "missing") return null;
  if (prTone === "conflicting") return <FixConflictsButton workspaceId={workspace.id} />;
  return <MergeButton workspace={workspace} pr={pr} />;
}

// Launches a fresh agent session against the daemon's fix-conflicts endpoint.
// The daemon refuses to spawn against a bash/sh/zsh/fish runtime (the prompt
// is multi-line and would execute line-by-line as commands), so the operator
// sees an error from `mutation.error` if no agent runtime is configured.
function FixConflictsButton(props: { workspaceId: string }) {
  const mutation = useMutation({
    mutationFn: () =>
      api<{ session: { id: string }; promptSource: string }>(`/api/workspaces/${props.workspaceId}/fix-conflicts`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["state"] });
      queryClient.invalidateQueries({ queryKey: ["cockpit-summary", props.workspaceId] });
    },
  });
  return (
    <div className="pr-card-action">
      <button
        type="button"
        className="pr-card-btn pr-card-btn-danger"
        onClick={(event) => {
          event.stopPropagation();
          mutation.mutate();
        }}
        disabled={mutation.isPending}
        title="Launch a fresh agent to resolve PR conflicts against main"
      >
        {mutation.isPending ? <Loader2 size={11} className="spin" /> : <GitPullRequest size={11} />}
        <span>{mutation.isPending ? "Launching…" : "Fix conflicts"}</span>
      </button>
      {mutation.isError ? (
        <span className="pr-card-action-err" title={mutation.error instanceof Error ? mutation.error.message : ""}>
          {mutation.error instanceof Error ? mutation.error.message : "Failed to launch agent"}
        </span>
      ) : null}
    </div>
  );
}

// Renders the Merge button + strategy dropdown. Gated on provider health
// (gh CLI) and PR.mergeable so we don't surface a button that would fail
// inside `gh pr merge`.
function MergeButton(props: { workspace: Workspace; pr: PullRequestSummary }) {
  const { workspace, pr } = props;
  const [open, setOpen] = useState(false);
  const allowed: PrMergeStrategy[] = pr.allowedMergeStrategies.length
    ? pr.allowedMergeStrategies
    : (["squash", "merge", "rebase"] as const).filter(() => false);
  const providerHealth = useQuery<{ providerHealth: ProviderHealth[] }>({
    queryKey: ["provider-health"],
    queryFn: () => api<{ providerHealth: ProviderHealth[] }>("/api/health"),
    refetchInterval: 60_000,
  });
  const ghHealthy = providerHealth.data?.providerHealth.find((entry) => entry.id === "github-gh")?.status === "healthy";
  const canMerge = pr.mergeable === "mergeable" && allowed.length > 0 && ghHealthy === true;
  const merge = useMutation({
    mutationFn: (strategy: PrMergeStrategy) =>
      api(`/api/workspaces/${workspace.id}/pr-merge`, {
        method: "POST",
        body: JSON.stringify({ strategy }),
      }),
    onSuccess: () => {
      setOpen(false);
      queryClient.invalidateQueries({ queryKey: ["workspace-cockpit", workspace.id] });
      queryClient.invalidateQueries({ queryKey: ["workspaces-pr-batch"] });
    },
  });
  const disabledReason =
    ghHealthy === false
      ? "GitHub CLI unavailable"
      : pr.mergeable !== "mergeable"
        ? "PR is not mergeable (unknown state — refresh to recheck)"
        : allowed.length === 0
          ? "Repository allows no merge strategies via gh"
          : null;
  return (
    <div className="pr-card-action pr-card-action--merge">
      <button
        type="button"
        className="pr-card-btn pr-card-btn-merge"
        onClick={(event) => {
          event.stopPropagation();
          if (canMerge) setOpen((value) => !value);
        }}
        disabled={!canMerge || merge.isPending}
        aria-disabled={!canMerge}
        title={disabledReason ?? `Merge PR #${pr.number}`}
      >
        {merge.isPending ? <Loader2 size={11} className="spin" /> : <GitMerge size={11} />}
        <span>{merge.isPending ? "Merging…" : "Merge"}</span>
      </button>
      {open && canMerge ? (
        <div className="pr-card-merge-menu" role="menu">
          {allowed.map((strategy) => (
            <button
              key={strategy}
              type="button"
              className="pr-card-merge-strategy"
              onClick={(event) => {
                event.stopPropagation();
                merge.mutate(strategy);
              }}
              disabled={merge.isPending}
              role="menuitem"
            >
              {strategy === "squash" ? "Squash & merge" : strategy === "rebase" ? "Rebase & merge" : "Merge commit"}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
