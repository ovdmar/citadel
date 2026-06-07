import type { ProviderHealth, PullRequestSummary, Workspace } from "@citadel/contracts";
import type { PrMergeStrategy } from "@citadel/contracts/pr-routes";
import { useMutation, useQuery } from "@tanstack/react-query";
import { GitMerge, GitPullRequest, Loader2, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { api, queryClient } from "./api.js";
import { markWorkspacePrMergedInQueryCache } from "./cockpit-tools.js";
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
  return <MergeButton key={`${workspace.id}:${pr.number}`} workspace={workspace} pr={pr} />;
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
  const [adminBypass, setAdminBypass] = useState(false);
  const allowed: PrMergeStrategy[] = pr.allowedMergeStrategies.length
    ? pr.allowedMergeStrategies
    : (["squash", "merge", "rebase"] as const).filter(() => false);
  useEffect(() => {
    setAdminBypass(false);
  }, [workspace.id, pr.number]);
  const providerHealth = useQuery<{ providerHealth: ProviderHealth[] }>({
    queryKey: ["provider-health"],
    queryFn: () => api<{ providerHealth: ProviderHealth[] }>("/api/health"),
    refetchInterval: 60_000,
  });
  const ghProvider = providerHealth.data?.providerHealth.find((entry) => entry.id === "github-gh") ?? null;
  const ghHealthy = ghProvider?.status === "healthy";
  const canMerge = pr.mergeable === "mergeable" && allowed.length > 0 && ghHealthy === true;
  const merge = useMutation({
    onMutate: async () => {
      await Promise.all([
        queryClient.cancelQueries({ queryKey: ["workspace-cockpit", workspace.id] }),
        queryClient.cancelQueries({ queryKey: ["workspaces-pr-batch"] }),
      ]);
    },
    mutationFn: (input: { strategy: PrMergeStrategy; admin: boolean }) =>
      api(`/api/workspaces/${workspace.id}/pr-merge`, {
        method: "POST",
        body: JSON.stringify(input.admin ? { strategy: input.strategy, admin: true } : { strategy: input.strategy }),
      }),
    onSuccess: () => {
      setOpen(false);
      markWorkspacePrMergedInQueryCache(queryClient, workspace.id, pr.number);
    },
    onSettled: () => {
      setAdminBypass(false);
    },
  });
  const disabledReason = mergeDisabledReason({
    allowedMergeStrategies: allowed,
    ghProvider,
    healthQueryError: providerHealth.isError,
    healthQueryLoading: providerHealth.isLoading,
    mergeable: pr.mergeable,
    mergePending: merge.isPending,
  });
  const buttonTitle = disabledReason ?? `Merge PR #${pr.number}`;
  return (
    <div className="pr-card-action pr-card-action--merge">
      <span
        className={`pr-card-action-tooltip ${disabledReason ? "is-disabled" : ""}`}
        title={buttonTitle}
        aria-label={buttonTitle}
      >
        <button
          type="button"
          className="pr-card-btn pr-card-btn-merge"
          onClick={(event) => {
            event.stopPropagation();
            if (canMerge)
              setOpen((value) => {
                setAdminBypass(false);
                return !value;
              });
          }}
          disabled={!canMerge || merge.isPending}
          aria-disabled={!canMerge || merge.isPending}
          title={buttonTitle}
        >
          {merge.isPending ? <Loader2 size={11} className="spin" /> : <GitMerge size={11} />}
          <span>{merge.isPending ? "Merging…" : "Merge"}</span>
        </button>
      </span>
      {open && canMerge ? (
        <div className="pr-card-merge-menu" role="menu">
          <button
            type="button"
            className="pr-card-merge-admin"
            onClick={(event) => {
              event.stopPropagation();
              setAdminBypass((value) => !value);
            }}
            disabled={merge.isPending}
            role="menuitemcheckbox"
            aria-checked={adminBypass}
          >
            <ShieldAlert size={11} aria-hidden="true" />
            <span className="pr-card-merge-admin-text">
              <span>Admin bypass</span>
              <span>Unmet requirements</span>
            </span>
          </button>
          {allowed.map((strategy) => (
            <button
              key={strategy}
              type="button"
              className="pr-card-merge-strategy"
              onClick={(event) => {
                event.stopPropagation();
                const selectedAdminBypass = adminBypass;
                setAdminBypass(false);
                merge.mutate({ strategy, admin: selectedAdminBypass });
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

export function mergeDisabledReason(input: {
  allowedMergeStrategies: readonly PrMergeStrategy[];
  ghProvider: ProviderHealth | null;
  healthQueryError: boolean;
  healthQueryLoading: boolean;
  mergeable: PullRequestSummary["mergeable"];
  mergePending: boolean;
}): string | null {
  if (input.mergePending) return "Merge in progress";
  if (input.mergeable === "conflicting") return "PR has merge conflicts with the base branch";
  if (input.mergeable === "unknown") return "PR mergeability is unknown; refresh to recheck";
  if (input.allowedMergeStrategies.length === 0) return "Repository allows no merge strategies via gh";
  if (input.ghProvider?.status !== "healthy") {
    if (input.ghProvider?.reason) return `GitHub CLI unavailable: ${input.ghProvider.reason}`;
    if (input.ghProvider) return "GitHub CLI unavailable";
    if (input.healthQueryError) return "Unable to check GitHub CLI availability";
    if (input.healthQueryLoading) return "Checking GitHub CLI availability";
    return "GitHub CLI health is unknown";
  }
  return null;
}
