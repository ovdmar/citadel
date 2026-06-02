import type {
  AgentToolAuthority,
  CheckoutCheckFact,
  CheckoutPrFact,
  IssueTransitionAttempt,
  LocalNotificationEvent,
  ManagerActionLedgerEntry,
  ProviderIssueFact,
  ReviewArtifact,
  WorkspacePlanDeliveryUnit,
  WorkspacePlanDependencyEdge,
  WorktreeCheckout,
} from "@citadel/contracts";
import type { SqliteStore } from "./index.js";
import {
  authorityFromRow,
  bindIdentityParams,
  deliveryUnitFromRow,
  dependencyEdgeFromRow,
  identityFromRow,
  issueFactFromRow,
  managerActionFromRow,
  transitionAttemptFromRow,
} from "./manager-orchestration-rows.js";
import { asString } from "./rows.js";

declare module "./index.js" {
  interface SqliteStore {
    insertWorkspacePlanDeliveryUnits(units: WorkspacePlanDeliveryUnit[]): void;
    listWorkspacePlanDeliveryUnits(planVersionId: string): WorkspacePlanDeliveryUnit[];
    insertWorkspacePlanDependencyEdges(edges: WorkspacePlanDependencyEdge[]): void;
    listWorkspacePlanDependencyEdges(planVersionId: string): WorkspacePlanDependencyEdge[];
    updateWorkspaceCheckoutDeliveryUnit(
      checkoutId: string,
      patch: Pick<WorktreeCheckout, "deliveryUnitKey" | "deliveryPlanVersionId">,
    ): WorktreeCheckout | null;
    claimManagerAction(action: ManagerActionLedgerEntry): ManagerActionLedgerEntry;
    renewManagerActionLease(
      id: string,
      ownerId: string,
      generation: number,
      patch: Pick<ManagerActionLedgerEntry, "leaseOwnerId" | "leaseExpiresAt">,
    ): ManagerActionLedgerEntry | null;
    completeManagerAction(
      id: string,
      ownerId: string,
      generation: number,
      patch: Partial<
        Pick<ManagerActionLedgerEntry, "status" | "operationId" | "sessionId" | "artifactId" | "completedAt" | "error">
      >,
    ): ManagerActionLedgerEntry | null;
    markManagerActionSuperseded(id: string, error?: string | null): ManagerActionLedgerEntry | null;
    reconcileExpiredManagerAction(
      id: string,
      ownerId: string,
      generation: number,
      now: string,
    ): ManagerActionLedgerEntry | null;
    findManagerActionByKey(idempotencyKey: string): ManagerActionLedgerEntry | null;
    listManagerActions(workspaceId: string): ManagerActionLedgerEntry[];
    reconcileManagerActions(now: string): ManagerActionLedgerEntry[];
    listCheckoutReviewArtifacts(
      checkoutId: string,
      filters?: { currentHeadSha?: string; includeInvalidated?: boolean },
    ): ReviewArtifact[];
    invalidateCheckoutReviewArtifacts(checkoutId: string, reason: string, headSha?: string): number;
    upsertProviderIssueFact(fact: ProviderIssueFact): void;
    listProviderIssueFacts(workspaceId: string): ProviderIssueFact[];
    insertIssueTransitionAttempt(attempt: IssueTransitionAttempt): void;
    listIssueTransitionAttempts(workspaceId: string): IssueTransitionAttempt[];
    upsertCheckoutPrFact(fact: CheckoutPrFact): void;
    listCheckoutPrFacts(checkoutId: string): CheckoutPrFact[];
    upsertCheckoutCheckFacts(facts: CheckoutCheckFact[]): void;
    listCheckoutCheckFacts(checkoutId: string): CheckoutCheckFact[];
    mintAgentToolAuthority(authority: AgentToolAuthority): void;
    validateAgentToolAuthority(tokenHash: string, now: string): AgentToolAuthority | null;
    revokeAgentToolAuthority(id: string, revokedAt: string, reason: string): AgentToolAuthority | null;
    revokeAuthoritiesForSession(sessionId: string, revokedAt: string, reason: string): number;
    revokeAuthoritiesForManagerAction(managerActionId: string, revokedAt: string, reason: string): number;
    listAgentToolAuthorities(sessionId?: string): AgentToolAuthority[];
    upsertLocalNotificationEvent(event: LocalNotificationEvent): void;
    listLocalNotificationEvents(workspaceId: string): LocalNotificationEvent[];
  }
}

export const managerOrchestrationStoreMethods = {
  insertWorkspacePlanDeliveryUnits(this: SqliteStore, units: WorkspacePlanDeliveryUnit[]) {
    const stmt = this.database.prepare(
      `INSERT OR REPLACE INTO workspace_plan_delivery_units (id, workspace_id, plan_version_id, key, repo_id,
        repo_name, provider_repo_url, checkout_name, branch, base_branch, child_issue_provider, child_issue_key,
        child_issue_url, child_issue_title, child_issue_status, child_issue_fetched_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const unit of units) {
      stmt.run(
        unit.id,
        unit.workspaceId,
        unit.planVersionId,
        unit.key,
        unit.repoId ?? null,
        unit.repoName ?? null,
        unit.providerRepoUrl ?? null,
        unit.checkoutName,
        unit.branch,
        unit.baseBranch ?? null,
        unit.childIssue?.provider ?? null,
        unit.childIssue?.key ?? null,
        unit.childIssue?.url ?? null,
        unit.childIssue?.title ?? null,
        unit.childIssue?.status ?? null,
        unit.childIssue?.fetchedAt ?? null,
        unit.status ?? "pending",
        unit.createdAt,
        unit.updatedAt,
      );
    }
  },

  listWorkspacePlanDeliveryUnits(this: SqliteStore, planVersionId: string): WorkspacePlanDeliveryUnit[] {
    const rows = this.database
      .prepare("SELECT * FROM workspace_plan_delivery_units WHERE plan_version_id = ? ORDER BY key")
      .all(planVersionId) as Array<Record<string, unknown>>;
    const edges = this.listWorkspacePlanDependencyEdges(planVersionId);
    return rows.map((row) => {
      const unit = deliveryUnitFromRow(row);
      return {
        ...unit,
        dependencies: edges.filter((edge) => edge.toUnitKey === unit.key).map(({ toUnitKey, ...edge }) => edge),
      };
    });
  },

  insertWorkspacePlanDependencyEdges(this: SqliteStore, edges: WorkspacePlanDependencyEdge[]) {
    const stmt = this.database.prepare(
      `INSERT OR REPLACE INTO workspace_plan_dependency_edges (id, workspace_id, plan_version_id, from_unit_key,
        to_unit_key, type, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const edge of edges) {
      stmt.run(
        edge.id,
        edge.workspaceId,
        edge.planVersionId,
        edge.fromUnitKey,
        edge.toUnitKey,
        edge.type,
        edge.reason ?? null,
        edge.createdAt,
      );
    }
  },

  listWorkspacePlanDependencyEdges(this: SqliteStore, planVersionId: string): WorkspacePlanDependencyEdge[] {
    const rows = this.database
      .prepare("SELECT * FROM workspace_plan_dependency_edges WHERE plan_version_id = ? ORDER BY to_unit_key")
      .all(planVersionId) as Array<Record<string, unknown>>;
    return rows.map(dependencyEdgeFromRow);
  },

  updateWorkspaceCheckoutDeliveryUnit(
    this: SqliteStore,
    checkoutId: string,
    patch: Pick<WorktreeCheckout, "deliveryUnitKey" | "deliveryPlanVersionId">,
  ): WorktreeCheckout | null {
    this.database
      .prepare(
        `UPDATE workspace_checkouts
         SET delivery_unit_key = ?, delivery_plan_version_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(patch.deliveryUnitKey ?? null, patch.deliveryPlanVersionId ?? null, new Date().toISOString(), checkoutId);
    return this.findWorkspaceCheckout(checkoutId);
  },

  claimManagerAction(this: SqliteStore, action: ManagerActionLedgerEntry): ManagerActionLedgerEntry {
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO manager_action_ledger (id, workspace_id, checkout_id, manager_id, action_name, status,
          scope_key, action_key, fact_key, idempotency_key, lease_owner_id, lease_generation, lease_expires_at,
          attempt_count, max_attempts, operation_id, session_id, artifact_id, pr_head_sha, plan_version_id,
          claimed_at, completed_at, last_reconciled_at, error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        action.id,
        action.workspaceId,
        action.checkoutId ?? null,
        action.managerId ?? null,
        action.actionName,
        action.status,
        action.scopeKey,
        action.actionKey,
        action.factKey ?? null,
        action.idempotencyKey,
        action.leaseOwnerId ?? null,
        action.leaseGeneration,
        action.leaseExpiresAt ?? null,
        action.attemptCount,
        action.maxAttempts,
        action.operationId ?? null,
        action.sessionId ?? null,
        action.artifactId ?? null,
        action.prHeadSha ?? null,
        action.planVersionId ?? null,
        action.claimedAt ?? null,
        action.completedAt ?? null,
        action.lastReconciledAt ?? null,
        action.error ?? null,
        action.createdAt,
        action.updatedAt,
      );
    if (!result.changes && action.leaseOwnerId) {
      const existing = this.findManagerActionByKey(action.idempotencyKey);
      if (existing?.status === "queued" && existing.attemptCount < existing.maxAttempts) {
        this.database
          .prepare(
            `UPDATE manager_action_ledger
             SET status = 'claimed', lease_owner_id = ?, lease_generation = lease_generation + 1,
               lease_expires_at = ?, attempt_count = attempt_count + 1,
               claimed_at = COALESCE(claimed_at, ?), error = NULL, updated_at = ?
            WHERE id = ? AND status = 'queued' AND attempt_count < max_attempts`,
          )
          .run(
            action.leaseOwnerId,
            action.leaseExpiresAt ?? null,
            action.claimedAt ?? action.updatedAt,
            action.updatedAt,
            existing.id,
          );
      }
    }
    const claimed = this.findManagerActionByKey(action.idempotencyKey);
    if (!claimed) throw new Error(`manager action claim disappeared: ${action.idempotencyKey}`);
    return claimed;
  },

  renewManagerActionLease(
    this: SqliteStore,
    id: string,
    ownerId: string,
    generation: number,
    patch: Pick<ManagerActionLedgerEntry, "leaseOwnerId" | "leaseExpiresAt">,
  ): ManagerActionLedgerEntry | null {
    const nextGeneration = generation + 1;
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        `UPDATE manager_action_ledger
         SET lease_owner_id = ?, lease_generation = ?, lease_expires_at = ?, status = 'claimed',
           claimed_at = COALESCE(claimed_at, ?), attempt_count = attempt_count + 1, updated_at = ?
         WHERE id = ? AND lease_owner_id = ? AND lease_generation = ?`,
      )
      .run(patch.leaseOwnerId, nextGeneration, patch.leaseExpiresAt ?? null, now, now, id, ownerId, generation);
    return result.changes ? findManagerActionById(this, id) : null;
  },

  completeManagerAction(
    this: SqliteStore,
    id: string,
    ownerId: string,
    generation: number,
    patch: Partial<
      Pick<ManagerActionLedgerEntry, "status" | "operationId" | "sessionId" | "artifactId" | "completedAt" | "error">
    >,
  ): ManagerActionLedgerEntry | null {
    const now = new Date().toISOString();
    const result = this.database
      .prepare(
        `UPDATE manager_action_ledger
         SET status = ?, operation_id = COALESCE(?, operation_id), session_id = COALESCE(?, session_id),
           artifact_id = COALESCE(?, artifact_id), completed_at = ?, error = ?, lease_owner_id = NULL,
           lease_expires_at = NULL, updated_at = ?
         WHERE id = ? AND lease_owner_id = ? AND lease_generation = ?`,
      )
      .run(
        patch.status ?? "succeeded",
        patch.operationId ?? null,
        patch.sessionId ?? null,
        patch.artifactId ?? null,
        patch.completedAt ?? now,
        patch.error ?? null,
        now,
        id,
        ownerId,
        generation,
      );
    return result.changes ? findManagerActionById(this, id) : null;
  },

  markManagerActionSuperseded(this: SqliteStore, id: string, error?: string | null): ManagerActionLedgerEntry | null {
    this.database
      .prepare(
        `UPDATE manager_action_ledger
         SET status = 'superseded', error = ?, lease_owner_id = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE id = ?`,
      )
      .run(error ?? null, new Date().toISOString(), id);
    return findManagerActionById(this, id);
  },

  reconcileExpiredManagerAction(
    this: SqliteStore,
    id: string,
    ownerId: string,
    generation: number,
    now: string,
  ): ManagerActionLedgerEntry | null {
    this.database
      .prepare(
        `UPDATE manager_action_ledger
         SET status = CASE WHEN attempt_count >= max_attempts THEN 'failed' ELSE 'queued' END,
           lease_owner_id = NULL, lease_expires_at = NULL, last_reconciled_at = ?,
           error = CASE WHEN attempt_count >= max_attempts THEN 'lease_expired_max_attempts' ELSE 'lease_expired' END,
           updated_at = ?
         WHERE id = ? AND lease_owner_id = ? AND lease_generation = ? AND status IN ('claimed', 'running')`,
      )
      .run(now, now, id, ownerId, generation);
    return findManagerActionById(this, id);
  },

  findManagerActionByKey(this: SqliteStore, idempotencyKey: string): ManagerActionLedgerEntry | null {
    const row = this.database
      .prepare("SELECT * FROM manager_action_ledger WHERE idempotency_key = ?")
      .get(idempotencyKey);
    return row ? managerActionFromRow(row as Record<string, unknown>) : null;
  },

  listManagerActions(this: SqliteStore, workspaceId: string): ManagerActionLedgerEntry[] {
    const rows = this.database
      .prepare("SELECT * FROM manager_action_ledger WHERE workspace_id = ? ORDER BY updated_at DESC")
      .all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map(managerActionFromRow);
  },

  reconcileManagerActions(this: SqliteStore, now: string): ManagerActionLedgerEntry[] {
    const rows = this.database
      .prepare(
        `SELECT * FROM manager_action_ledger
         WHERE status IN ('claimed', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
         ORDER BY lease_expires_at ASC`,
      )
      .all(now) as Array<Record<string, unknown>>;
    return rows.map(managerActionFromRow);
  },

  listCheckoutReviewArtifacts(
    this: SqliteStore,
    checkoutId: string,
    filters: { currentHeadSha?: string; includeInvalidated?: boolean } = {},
  ): ReviewArtifact[] {
    return this.listReviewArtifacts(checkoutId).filter((artifact) => {
      if (filters.currentHeadSha && artifact.headSha !== filters.currentHeadSha) return false;
      if (!filters.includeInvalidated && artifact.invalidatedAt) return false;
      return true;
    });
  },

  invalidateCheckoutReviewArtifacts(this: SqliteStore, checkoutId: string, reason: string, headSha?: string): number {
    const now = new Date().toISOString();
    const result = headSha
      ? this.database
          .prepare(
            `UPDATE checkout_review_artifacts
             SET invalidated_at = ?, invalidated_reason = ?
             WHERE checkout_id = ? AND head_sha != ? AND invalidated_at IS NULL`,
          )
          .run(now, reason, checkoutId, headSha)
      : this.database
          .prepare(
            `UPDATE checkout_review_artifacts
             SET invalidated_at = ?, invalidated_reason = ?
             WHERE checkout_id = ? AND invalidated_at IS NULL`,
          )
          .run(now, reason, checkoutId);
    return result.changes;
  },

  upsertProviderIssueFact(this: SqliteStore, fact: ProviderIssueFact) {
    this.database
      .prepare(
        `INSERT OR REPLACE INTO provider_issue_facts (id, workspace_id, checkout_id, delivery_unit_key,
          provider_type, provider_instance_id, account_id, host_url, external_url, workspace_binding_id,
          source_binding_type, source_binding_id, issue_id, issue_key, title, status, acceptance_snapshot,
          fetched_at, stale_at, degraded_reason, cooldown_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fact.id,
        fact.workspaceId,
        fact.checkoutId ?? null,
        fact.deliveryUnitKey ?? null,
        ...bindIdentityParams(fact.identity),
        fact.issueId ?? null,
        fact.issueKey,
        fact.title ?? null,
        fact.status ?? null,
        fact.acceptanceSnapshot ?? null,
        fact.fetchedAt,
        fact.staleAt ?? null,
        fact.degradedReason ?? null,
        fact.cooldownUntil ?? null,
      );
  },

  listProviderIssueFacts(this: SqliteStore, workspaceId: string): ProviderIssueFact[] {
    const rows = this.database
      .prepare("SELECT * FROM provider_issue_facts WHERE workspace_id = ? ORDER BY fetched_at DESC")
      .all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map(issueFactFromRow);
  },

  insertIssueTransitionAttempt(this: SqliteStore, attempt: IssueTransitionAttempt) {
    this.database
      .prepare(
        `INSERT INTO issue_transition_attempts (id, workspace_id, checkout_id, manager_action_id, provider_type,
          provider_instance_id, account_id, host_url, external_url, workspace_binding_id, source_binding_type,
          source_binding_id, issue_id, issue_key, requested_internal_state, current_external_status,
          selected_transition, resulting_external_status, success, degraded_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.id,
        attempt.workspaceId,
        attempt.checkoutId ?? null,
        attempt.managerActionId ?? null,
        ...bindIdentityParams(attempt.identity),
        attempt.issueId ?? null,
        attempt.issueKey,
        attempt.requestedInternalState,
        attempt.currentExternalStatus ?? null,
        attempt.selectedTransition ?? null,
        attempt.resultingExternalStatus ?? null,
        Number(attempt.success),
        attempt.degradedReason ?? null,
        attempt.createdAt,
      );
  },

  listIssueTransitionAttempts(this: SqliteStore, workspaceId: string): IssueTransitionAttempt[] {
    const rows = this.database
      .prepare("SELECT * FROM issue_transition_attempts WHERE workspace_id = ? ORDER BY created_at DESC")
      .all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map(transitionAttemptFromRow);
  },

  upsertCheckoutPrFact(this: SqliteStore, fact: CheckoutPrFact) {
    this.database
      .prepare(
        `INSERT OR REPLACE INTO checkout_pr_facts (id, workspace_id, checkout_id, provider_type,
          provider_instance_id, account_id, host_url, external_url, workspace_binding_id, source_binding_type,
          source_binding_id, repository_id, provider_repository_key, pr_id, pr_number, pr_url, head_sha,
          base_ref, merge_state_status, has_conflicts, fetched_at, stale_at, degraded_reason, cooldown_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        fact.id,
        fact.workspaceId,
        fact.checkoutId,
        ...bindIdentityParams(fact.identity),
        fact.identity.repositoryId ?? null,
        fact.identity.providerRepositoryKey ?? null,
        fact.prId ?? null,
        fact.prNumber ?? null,
        fact.prUrl ?? null,
        fact.headSha ?? null,
        fact.baseRef ?? null,
        fact.mergeStateStatus ?? null,
        fact.hasConflicts == null ? null : Number(fact.hasConflicts),
        fact.fetchedAt,
        fact.staleAt ?? null,
        fact.degradedReason ?? null,
        fact.cooldownUntil ?? null,
      );
  },

  listCheckoutPrFacts(this: SqliteStore, checkoutId: string): CheckoutPrFact[] {
    const rows = this.database
      .prepare("SELECT * FROM checkout_pr_facts WHERE checkout_id = ? ORDER BY fetched_at DESC")
      .all(checkoutId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: asString(row, "id"),
      workspaceId: asString(row, "workspace_id"),
      checkoutId: asString(row, "checkout_id"),
      identity: {
        ...identityFromRow(row),
        repositoryId: row.repository_id ? asString(row, "repository_id") : null,
        providerRepositoryKey: row.provider_repository_key ? asString(row, "provider_repository_key") : null,
      },
      prId: row.pr_id ? asString(row, "pr_id") : null,
      prNumber: row.pr_number === null || row.pr_number === undefined ? null : Number(row.pr_number),
      prUrl: row.pr_url ? asString(row, "pr_url") : null,
      headSha: row.head_sha ? asString(row, "head_sha") : null,
      baseRef: row.base_ref ? asString(row, "base_ref") : null,
      mergeStateStatus: row.merge_state_status ? asString(row, "merge_state_status") : null,
      hasConflicts:
        row.has_conflicts === null || row.has_conflicts === undefined ? null : Number(row.has_conflicts) === 1,
      fetchedAt: asString(row, "fetched_at"),
      staleAt: row.stale_at ? asString(row, "stale_at") : null,
      degradedReason: row.degraded_reason ? asString(row, "degraded_reason") : null,
      cooldownUntil: row.cooldown_until ? asString(row, "cooldown_until") : null,
    }));
  },

  upsertCheckoutCheckFacts(this: SqliteStore, facts: CheckoutCheckFact[]) {
    const stmt = this.database.prepare(
      `INSERT OR REPLACE INTO checkout_check_facts (id, workspace_id, checkout_id, pr_fact_id, provider_type,
        provider_instance_id, account_id, host_url, external_url, workspace_binding_id, source_binding_type,
        source_binding_id, repository_id, provider_repository_key, head_sha, check_id, name, status, conclusion,
        details_url, started_at, completed_at, fetched_at, stale_at, degraded_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const fact of facts) {
      stmt.run(
        fact.id,
        fact.workspaceId,
        fact.checkoutId,
        fact.prFactId ?? null,
        ...bindIdentityParams(fact.identity),
        fact.identity.repositoryId ?? null,
        fact.identity.providerRepositoryKey ?? null,
        fact.headSha,
        fact.checkId ?? null,
        fact.name,
        fact.status,
        fact.conclusion ?? null,
        fact.detailsUrl ?? null,
        fact.startedAt ?? null,
        fact.completedAt ?? null,
        fact.fetchedAt,
        fact.staleAt ?? null,
        fact.degradedReason ?? null,
      );
    }
  },

  listCheckoutCheckFacts(this: SqliteStore, checkoutId: string): CheckoutCheckFact[] {
    const rows = this.database
      .prepare("SELECT * FROM checkout_check_facts WHERE checkout_id = ? ORDER BY name")
      .all(checkoutId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: asString(row, "id"),
      workspaceId: asString(row, "workspace_id"),
      checkoutId: asString(row, "checkout_id"),
      prFactId: row.pr_fact_id ? asString(row, "pr_fact_id") : null,
      identity: {
        ...identityFromRow(row),
        repositoryId: row.repository_id ? asString(row, "repository_id") : null,
        providerRepositoryKey: row.provider_repository_key ? asString(row, "provider_repository_key") : null,
      },
      headSha: asString(row, "head_sha"),
      checkId: row.check_id ? asString(row, "check_id") : null,
      name: asString(row, "name"),
      status: asString(row, "status"),
      conclusion: row.conclusion ? asString(row, "conclusion") : null,
      detailsUrl: row.details_url ? asString(row, "details_url") : null,
      startedAt: row.started_at ? asString(row, "started_at") : null,
      completedAt: row.completed_at ? asString(row, "completed_at") : null,
      fetchedAt: asString(row, "fetched_at"),
      staleAt: row.stale_at ? asString(row, "stale_at") : null,
      degradedReason: row.degraded_reason ? asString(row, "degraded_reason") : null,
    }));
  },

  mintAgentToolAuthority(this: SqliteStore, authority: AgentToolAuthority) {
    this.database
      .prepare(
        `INSERT INTO agent_tool_authorities (id, token_hash, session_id, role, action_id, checkout_id,
          plan_version_id, manager_action_id, allowed_tool_names, issued_at, expires_at, revoked_at,
          revocation_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        authority.id,
        authority.tokenHash,
        authority.sessionId,
        authority.role ?? null,
        authority.actionId ?? null,
        authority.checkoutId ?? null,
        authority.planVersionId ?? null,
        authority.managerActionId ?? null,
        JSON.stringify(authority.allowedToolNames),
        authority.issuedAt,
        authority.expiresAt,
        authority.revokedAt ?? null,
        authority.revocationReason ?? null,
        authority.createdAt,
        authority.updatedAt,
      );
  },

  validateAgentToolAuthority(this: SqliteStore, tokenHash: string, now: string): AgentToolAuthority | null {
    const row = this.database
      .prepare(
        `SELECT * FROM agent_tool_authorities
         WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
      )
      .get(tokenHash, now);
    return row ? authorityFromRow(row as Record<string, unknown>) : null;
  },

  revokeAgentToolAuthority(
    this: SqliteStore,
    id: string,
    revokedAt: string,
    reason: string,
  ): AgentToolAuthority | null {
    this.database
      .prepare(
        `UPDATE agent_tool_authorities
         SET revoked_at = COALESCE(revoked_at, ?), revocation_reason = COALESCE(revocation_reason, ?), updated_at = ?
         WHERE id = ?`,
      )
      .run(revokedAt, reason, revokedAt, id);
    const row = this.database.prepare("SELECT * FROM agent_tool_authorities WHERE id = ?").get(id);
    return row ? authorityFromRow(row as Record<string, unknown>) : null;
  },

  revokeAuthoritiesForSession(this: SqliteStore, sessionId: string, revokedAt: string, reason: string): number {
    return this.database
      .prepare(
        `UPDATE agent_tool_authorities
         SET revoked_at = COALESCE(revoked_at, ?), revocation_reason = COALESCE(revocation_reason, ?), updated_at = ?
         WHERE session_id = ? AND revoked_at IS NULL`,
      )
      .run(revokedAt, reason, revokedAt, sessionId).changes;
  },

  revokeAuthoritiesForManagerAction(
    this: SqliteStore,
    managerActionId: string,
    revokedAt: string,
    reason: string,
  ): number {
    return this.database
      .prepare(
        `UPDATE agent_tool_authorities
         SET revoked_at = COALESCE(revoked_at, ?), revocation_reason = COALESCE(revocation_reason, ?), updated_at = ?
         WHERE manager_action_id = ? AND revoked_at IS NULL`,
      )
      .run(revokedAt, reason, revokedAt, managerActionId).changes;
  },

  listAgentToolAuthorities(this: SqliteStore, sessionId?: string): AgentToolAuthority[] {
    const stmt = sessionId
      ? this.database.prepare("SELECT * FROM agent_tool_authorities WHERE session_id = ? ORDER BY issued_at DESC")
      : this.database.prepare("SELECT * FROM agent_tool_authorities ORDER BY issued_at DESC");
    const rows = (sessionId ? stmt.all(sessionId) : stmt.all()) as Array<Record<string, unknown>>;
    return rows.map(authorityFromRow);
  },

  upsertLocalNotificationEvent(this: SqliteStore, event: LocalNotificationEvent) {
    this.database
      .prepare(
        `INSERT OR REPLACE INTO local_notification_events (id, workspace_id, checkout_id, type, status, title,
          message, dedupe_key, triggering_fact_fingerprint, manager_action_id, resolved_at, rearmed_at,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.workspaceId,
        event.checkoutId ?? null,
        event.type,
        event.status,
        event.title,
        event.message,
        event.dedupeKey,
        event.triggeringFactFingerprint,
        event.managerActionId ?? null,
        event.resolvedAt ?? null,
        event.rearmedAt ?? null,
        event.createdAt,
        event.updatedAt,
      );
  },

  listLocalNotificationEvents(this: SqliteStore, workspaceId: string): LocalNotificationEvent[] {
    const rows = this.database
      .prepare("SELECT * FROM local_notification_events WHERE workspace_id = ? ORDER BY updated_at DESC")
      .all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: asString(row, "id"),
      workspaceId: asString(row, "workspace_id"),
      checkoutId: row.checkout_id ? asString(row, "checkout_id") : null,
      type: asString(row, "type") as LocalNotificationEvent["type"],
      status: asString(row, "status") as LocalNotificationEvent["status"],
      title: asString(row, "title"),
      message: asString(row, "message"),
      dedupeKey: asString(row, "dedupe_key"),
      triggeringFactFingerprint: asString(row, "triggering_fact_fingerprint"),
      managerActionId: row.manager_action_id ? asString(row, "manager_action_id") : null,
      resolvedAt: row.resolved_at ? asString(row, "resolved_at") : null,
      rearmedAt: row.rearmed_at ? asString(row, "rearmed_at") : null,
      createdAt: asString(row, "created_at"),
      updatedAt: asString(row, "updated_at"),
    }));
  },
};

function findManagerActionById(store: SqliteStore, id: string): ManagerActionLedgerEntry | null {
  const row = store.database.prepare("SELECT * FROM manager_action_ledger WHERE id = ?").get(id);
  return row ? managerActionFromRow(row as Record<string, unknown>) : null;
}
