import type {
  AgentToolAuthority,
  IssueTransitionAttempt,
  ManagerActionLedgerEntry,
  ProviderFactIdentity,
  ProviderIssueFact,
  WorkspacePlanDeliveryUnit,
  WorkspacePlanDependencyEdge,
} from "@citadel/contracts";
import { asString, jsonArray } from "./rows.js";

export function deliveryUnitFromRow(row: Record<string, unknown>): WorkspacePlanDeliveryUnit {
  return {
    id: asString(row, "id"),
    workspaceId: asString(row, "workspace_id"),
    planVersionId: asString(row, "plan_version_id"),
    key: asString(row, "key"),
    repoId: row.repo_id ? asString(row, "repo_id") : null,
    repoName: row.repo_name ? asString(row, "repo_name") : null,
    providerRepoUrl: row.provider_repo_url ? asString(row, "provider_repo_url") : null,
    checkoutName: asString(row, "checkout_name"),
    branch: asString(row, "branch"),
    baseBranch: row.base_branch ? asString(row, "base_branch") : null,
    childIssue:
      row.child_issue_provider && row.child_issue_key
        ? {
            provider: asString(row, "child_issue_provider"),
            key: asString(row, "child_issue_key"),
            url: row.child_issue_url ? asString(row, "child_issue_url") : null,
            title: row.child_issue_title ? asString(row, "child_issue_title") : null,
            status: row.child_issue_status ? asString(row, "child_issue_status") : null,
            fetchedAt: row.child_issue_fetched_at ? asString(row, "child_issue_fetched_at") : null,
          }
        : null,
    dependencies: [],
    status: asString(row, "status") as WorkspacePlanDeliveryUnit["status"],
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}

export function dependencyEdgeFromRow(row: Record<string, unknown>): WorkspacePlanDependencyEdge {
  return {
    id: asString(row, "id"),
    workspaceId: asString(row, "workspace_id"),
    planVersionId: asString(row, "plan_version_id"),
    fromUnitKey: asString(row, "from_unit_key"),
    toUnitKey: asString(row, "to_unit_key"),
    type: asString(row, "type") as WorkspacePlanDependencyEdge["type"],
    reason: row.reason ? asString(row, "reason") : null,
    createdAt: asString(row, "created_at"),
  };
}

export function managerActionFromRow(row: Record<string, unknown>): ManagerActionLedgerEntry {
  return {
    id: asString(row, "id"),
    workspaceId: asString(row, "workspace_id"),
    checkoutId: row.checkout_id ? asString(row, "checkout_id") : null,
    managerId: row.manager_id ? asString(row, "manager_id") : null,
    actionName: asString(row, "action_name") as ManagerActionLedgerEntry["actionName"],
    status: asString(row, "status") as ManagerActionLedgerEntry["status"],
    scopeKey: asString(row, "scope_key"),
    actionKey: asString(row, "action_key"),
    factKey: row.fact_key ? asString(row, "fact_key") : null,
    idempotencyKey: asString(row, "idempotency_key"),
    leaseOwnerId: row.lease_owner_id ? asString(row, "lease_owner_id") : null,
    leaseGeneration: Number(row.lease_generation),
    leaseExpiresAt: row.lease_expires_at ? asString(row, "lease_expires_at") : null,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    operationId: row.operation_id ? asString(row, "operation_id") : null,
    sessionId: row.session_id ? asString(row, "session_id") : null,
    artifactId: row.artifact_id ? asString(row, "artifact_id") : null,
    prHeadSha: row.pr_head_sha ? asString(row, "pr_head_sha") : null,
    planVersionId: row.plan_version_id ? asString(row, "plan_version_id") : null,
    claimedAt: row.claimed_at ? asString(row, "claimed_at") : null,
    completedAt: row.completed_at ? asString(row, "completed_at") : null,
    lastReconciledAt: row.last_reconciled_at ? asString(row, "last_reconciled_at") : null,
    error: row.error ? asString(row, "error") : null,
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}

export function identityFromRow(row: Record<string, unknown>): ProviderFactIdentity {
  return {
    providerType: asString(row, "provider_type"),
    providerInstanceId: asString(row, "provider_instance_id"),
    accountId: row.account_id ? asString(row, "account_id") : null,
    hostUrl: row.host_url ? asString(row, "host_url") : null,
    externalUrl: row.external_url ? asString(row, "external_url") : null,
    workspaceBindingId: row.workspace_binding_id ? asString(row, "workspace_binding_id") : null,
    sourceBindingType: asString(row, "source_binding_type") as ProviderFactIdentity["sourceBindingType"],
    sourceBindingId: asString(row, "source_binding_id"),
  };
}

export function issueFactFromRow(row: Record<string, unknown>): ProviderIssueFact {
  return {
    id: asString(row, "id"),
    workspaceId: asString(row, "workspace_id"),
    checkoutId: row.checkout_id ? asString(row, "checkout_id") : null,
    deliveryUnitKey: row.delivery_unit_key ? asString(row, "delivery_unit_key") : null,
    identity: identityFromRow(row),
    issueId: row.issue_id ? asString(row, "issue_id") : null,
    issueKey: asString(row, "issue_key"),
    title: row.title ? asString(row, "title") : null,
    status: row.status ? asString(row, "status") : null,
    acceptanceSnapshot: row.acceptance_snapshot ? asString(row, "acceptance_snapshot") : null,
    fetchedAt: asString(row, "fetched_at"),
    staleAt: row.stale_at ? asString(row, "stale_at") : null,
    degradedReason: row.degraded_reason ? asString(row, "degraded_reason") : null,
    cooldownUntil: row.cooldown_until ? asString(row, "cooldown_until") : null,
  };
}

export function transitionAttemptFromRow(row: Record<string, unknown>): IssueTransitionAttempt {
  return {
    id: asString(row, "id"),
    workspaceId: asString(row, "workspace_id"),
    checkoutId: row.checkout_id ? asString(row, "checkout_id") : null,
    managerActionId: row.manager_action_id ? asString(row, "manager_action_id") : null,
    identity: identityFromRow(row),
    issueId: row.issue_id ? asString(row, "issue_id") : null,
    issueKey: asString(row, "issue_key"),
    requestedInternalState: asString(
      row,
      "requested_internal_state",
    ) as IssueTransitionAttempt["requestedInternalState"],
    currentExternalStatus: row.current_external_status ? asString(row, "current_external_status") : null,
    selectedTransition: row.selected_transition ? asString(row, "selected_transition") : null,
    resultingExternalStatus: row.resulting_external_status ? asString(row, "resulting_external_status") : null,
    success: Number(row.success) === 1,
    degradedReason: row.degraded_reason ? asString(row, "degraded_reason") : null,
    createdAt: asString(row, "created_at"),
  };
}

export function authorityFromRow(row: Record<string, unknown>): AgentToolAuthority {
  return {
    id: asString(row, "id"),
    tokenHash: asString(row, "token_hash"),
    sessionId: asString(row, "session_id"),
    role: row.role ? (asString(row, "role") as AgentToolAuthority["role"]) : null,
    actionId: row.action_id ? asString(row, "action_id") : null,
    checkoutId: row.checkout_id ? asString(row, "checkout_id") : null,
    planVersionId: row.plan_version_id ? asString(row, "plan_version_id") : null,
    managerActionId: row.manager_action_id ? asString(row, "manager_action_id") : null,
    allowedToolNames: jsonArray(row, "allowed_tool_names"),
    issuedAt: asString(row, "issued_at"),
    expiresAt: asString(row, "expires_at"),
    revokedAt: row.revoked_at ? asString(row, "revoked_at") : null,
    revocationReason: row.revocation_reason ? asString(row, "revocation_reason") : null,
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}

export function bindIdentityParams(identity: ProviderFactIdentity): unknown[] {
  return [
    identity.providerType,
    identity.providerInstanceId,
    identity.accountId ?? null,
    identity.hostUrl ?? null,
    identity.externalUrl ?? null,
    identity.workspaceBindingId ?? null,
    identity.sourceBindingType,
    identity.sourceBindingId,
  ];
}
