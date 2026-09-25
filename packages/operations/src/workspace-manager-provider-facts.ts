import type { CheckoutPrFact, IssueBinding, ProviderIssueFact, Workspace, WorktreeCheckout } from "@citadel/contracts";
import { stableId } from "./stable-id.js";

export function issueFactFromBinding(
  workspace: Workspace,
  checkout: WorktreeCheckout | null,
  deliveryUnitKey: string | null | undefined,
  issue: IssueBinding,
  timestamp: string,
): ProviderIssueFact {
  const sourceBindingType = checkout
    ? "checkout_child_issue"
    : deliveryUnitKey
      ? "plan_delivery_unit"
      : "workspace_parent_issue";
  const sourceBindingId = checkout?.id ?? deliveryUnitKey ?? workspace.id;
  return {
    id: stableId(
      "pif",
      workspace.id,
      checkout?.id ?? "workspace",
      deliveryUnitKey ?? "no_unit",
      issue.provider,
      issue.key,
    ),
    workspaceId: workspace.id,
    checkoutId: checkout?.id ?? null,
    deliveryUnitKey: deliveryUnitKey ?? null,
    identity: {
      providerType: issue.provider,
      providerInstanceId: issue.provider,
      accountId: null,
      hostUrl: null,
      externalUrl: issue.url,
      workspaceBindingId: workspace.id,
      sourceBindingType,
      sourceBindingId,
    },
    issueId: null,
    issueKey: issue.key,
    title: issue.title ?? null,
    status: issue.status ?? null,
    acceptanceSnapshot: null,
    fetchedAt: issue.fetchedAt ?? timestamp,
    staleAt: null,
    degradedReason: null,
    cooldownUntil: null,
  };
}

export function prFactFromBinding(workspace: Workspace, checkout: WorktreeCheckout, timestamp: string): CheckoutPrFact {
  const pr = checkout.intendedPr;
  if (!pr) throw new Error("pr_required");
  return {
    id: stableId("cpf", workspace.id, checkout.id, pr.provider, String(pr.number ?? pr.url ?? "pr")),
    workspaceId: workspace.id,
    checkoutId: checkout.id,
    identity: {
      providerType: pr.provider,
      providerInstanceId: pr.provider,
      accountId: null,
      hostUrl: null,
      externalUrl: pr.url,
      workspaceBindingId: workspace.id,
      sourceBindingType: "checkout_pr",
      sourceBindingId: checkout.id,
      repositoryId: checkout.repoId,
      providerRepositoryKey: null,
    },
    prId: null,
    prNumber: pr.number ?? null,
    prUrl: pr.url ?? null,
    headSha: pr.headSha ?? null,
    baseRef: pr.baseRef ?? null,
    mergeStateStatus: pr.mergeStateStatus ?? null,
    hasConflicts: pr.hasConflicts ?? null,
    fetchedAt: pr.fetchedAt ?? timestamp,
    staleAt: null,
    degradedReason: null,
    cooldownUntil: null,
  };
}
