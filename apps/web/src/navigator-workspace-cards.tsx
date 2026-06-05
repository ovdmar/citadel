import type {
  PullRequestSummary,
  Repo,
  Workspace,
  WorkspaceDirtySummary,
  WorkspaceSession,
  WorktreeCheckout,
} from "@citadel/contracts";
import { useMutation } from "@tanstack/react-query";
import { X } from "lucide-react";
import { useState } from "react";
import { api, queryClient } from "./api.js";
import { type StateResponse, useOptimisticRemove } from "./app-state.js";
import { repoNameWithOwner } from "./repo-labels.js";
import type { AttentionSessionIds } from "./session-status-display.js";
import { useToast } from "./toast.js";
import { useOverlayPresent } from "./use-overlay-present.js";
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
  unseenAttentionSessionIds?: AttentionSessionIds | undefined;
};

export function hasNestedCheckouts(checkouts: readonly WorktreeCheckout[]): boolean {
  return checkouts.length > 0;
}

export function workspaceAggregateBranchLabel(input: {
  checkouts: readonly WorktreeCheckout[];
  sessions: readonly WorkspaceSession[];
  pullRequest: PullRequestSummary | null;
  prCount?: number;
}): string {
  const repoCount = new Set(input.checkouts.map((checkout) => checkout.repoId)).size;
  const prCount = input.prCount ?? aggregatePrCount(input.checkouts, input.pullRequest);
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

export function isWorkspaceMainCheckout(workspace: Workspace, checkout: WorktreeCheckout): boolean {
  return (
    checkout.workspaceId === workspace.id && (checkout.path === workspace.path || checkout.path === workspace.rootPath)
  );
}

export function workspaceCheckoutRows(
  workspace: Workspace,
  checkouts: readonly WorktreeCheckout[],
): { visibleCheckouts: WorktreeCheckout[]; aggregateCheckouts: readonly WorktreeCheckout[] } {
  return {
    visibleCheckouts: checkouts.filter((checkout) => !isWorkspaceMainCheckout(workspace, checkout)),
    aggregateCheckouts: checkouts,
  };
}

export function CheckoutNavCard(props: CheckoutNavCardProps) {
  const [confirmDrop, setConfirmDrop] = useState(false);
  const displayName = props.checkout.displayName ?? props.checkout.name;
  const workspaceForCard: Workspace = {
    ...props.workspace,
    repoId: props.checkout.repoId,
    name: displayName,
    branch: props.checkout.branch,
    baseBranch: props.checkout.baseBranch,
    kind: "worktree",
    issueKey: null,
    issueTitle: null,
    issueUrl: null,
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
        displayTitle={displayName}
        renameLabel="Rename worktree card"
        onRename={(nextName) =>
          api(`/api/workspaces/${props.workspace.id}/checkouts/${props.checkout.id}`, {
            method: "PATCH",
            body: JSON.stringify({ displayName: nextName }),
          })
        }
        prToneOverride={prTone}
        lifecyclePullRequest={null}
        unseenAttentionSessionIds={props.unseenAttentionSessionIds}
        disableDrop
      />
      <button
        type="button"
        className="workspace-card-drop nav-checkout-drop"
        aria-label={`Drop checkout ${props.checkout.name}`}
        title="Drop checkout"
        onClick={(event) => {
          event.stopPropagation();
          setConfirmDrop(true);
        }}
      >
        <X size={11} />
      </button>
      {confirmDrop ? (
        <DropCheckoutDialog
          workspace={props.workspace}
          checkout={props.checkout}
          onClose={() => setConfirmDrop(false)}
        />
      ) : null}
    </div>
  );
}

type DropCheckoutResult = {
  removed: boolean;
  dirty: boolean;
  error?: string | null;
  dirtySummary?: WorkspaceDirtySummary | null;
};

function DropCheckoutDialog(props: { workspace: Workspace; checkout: WorktreeCheckout; onClose: () => void }) {
  useOverlayPresent();
  const optimistic = useOptimisticRemove();
  const toast = useToast();
  const checkoutId = props.checkout.id;
  const drop = useMutation({
    mutationFn: async (): Promise<DropCheckoutResult> => {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(props.workspace.id)}/checkouts/${encodeURIComponent(props.checkout.id)}`,
        { method: "DELETE", headers: { "Content-Type": "application/json" } },
      );
      const body = (await response.json().catch(() => ({}))) as Partial<DropCheckoutResult> & { error?: string };
      if (!response.ok && !body.dirty) throw new Error(body.error ?? "checkout_remove_failed");
      return {
        removed: Boolean(body.removed),
        dirty: Boolean(body.dirty),
        error: body.error ?? null,
        dirtySummary: body.dirtySummary ?? null,
      };
    },
    onMutate: () => {
      optimistic.addCheckout(checkoutId);
      const previous = queryClient.getQueryData<StateResponse>(["state"]);
      if (previous) {
        queryClient.setQueryData<StateResponse>(["state"], {
          ...previous,
          checkouts: previous.checkouts.filter((checkout) => checkout.id !== checkoutId),
        });
      }
      return { previous };
    },
    onSuccess: (result, _vars, context) => {
      if (result.removed) {
        queryClient.invalidateQueries({ queryKey: ["state"] });
        props.onClose();
        return;
      }
      if (context?.previous) queryClient.setQueryData(["state"], context.previous);
      queryClient.invalidateQueries({ queryKey: ["state"] });
      const reason = result.dirty ? "uncommitted changes or unpushed commits" : (result.error ?? "teardown failed");
      toast.push({ tone: "error", message: `Drop "${props.checkout.name}" failed: ${reason}` });
    },
    onError: (error, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(["state"], context.previous);
      queryClient.invalidateQueries({ queryKey: ["state"] });
      toast.push({
        tone: "error",
        message: `Drop "${props.checkout.name}" failed: ${error instanceof Error ? error.message : "network error"}`,
      });
    },
    onSettled: () => {
      optimistic.removeCheckout(checkoutId);
    },
  });
  const dirtySummary = drop.data?.dirtySummary ?? null;
  const dirtyBlocked = Boolean(drop.data && !drop.data.removed && drop.data.dirty);
  return (
    <div className="drop-workspace-backdrop" onMouseDown={props.onClose}>
      <dialog
        className="drop-workspace-dialog"
        aria-label={`Drop checkout ${props.checkout.name}`}
        open
        onMouseDown={(event) => event.stopPropagation()}
      >
        <strong>Drop checkout "{props.checkout.name}"?</strong>
        <p>
          This runs teardown for the checkout and removes its git worktree. Deletion is blocked if it has uncommitted
          changes or unpushed commits.
        </p>
        {dirtyBlocked ? (
          <p className="drop-workspace-error">Checkout has uncommitted changes or unpushed commits.</p>
        ) : null}
        {dirtySummary && (dirtySummary.files.length > 0 || dirtySummary.unpushedCommits.length > 0) ? (
          <fieldset className="drop-workspace-summary" aria-label="Blocking changes">
            {dirtySummary.files.length > 0 ? (
              <details open>
                <summary>Uncommitted changes ({dirtySummary.files.length})</summary>
                <ul className="drop-workspace-summary-list">
                  {dirtySummary.files.map((file) => (
                    <li key={file.path}>
                      <code className="drop-workspace-summary-status">{file.status}</code>
                      <span className="drop-workspace-summary-path">{file.path}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
            {dirtySummary.unpushedCommits.length > 0 ? (
              <details open>
                <summary>Unpushed commits ({dirtySummary.unpushedCommits.length})</summary>
                <ul className="drop-workspace-summary-list">
                  {dirtySummary.unpushedCommits.map((commit) => (
                    <li key={commit.sha}>
                      <code className="drop-workspace-summary-sha">{commit.sha.slice(0, 7)}</code>
                      <span className="drop-workspace-summary-subject">{commit.subject}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </fieldset>
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
            {drop.isPending ? "Dropping..." : "Drop checkout"}
          </button>
        </div>
      </dialog>
    </div>
  );
}

export function checkoutBranchLabel(checkout: WorktreeCheckout, repo: Repo | null): string {
  return repo ? `${repoNameWithOwner(repo)} · ${checkout.branch}` : checkout.branch;
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
