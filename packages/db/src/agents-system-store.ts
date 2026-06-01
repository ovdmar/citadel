import type {
  IssueBinding,
  ManagerEvent,
  PlanDeviationReport,
  PullRequestBinding,
  ReviewArtifact,
  WorkspaceManager,
  WorkspacePlanDecision,
  WorkspacePlanReview,
  WorkspacePlanVersion,
  WorktreeCheckout,
} from "@citadel/contracts";
import type { SqliteStore } from "./index.js";
import { asString, jsonArray } from "./rows.js";

declare module "./index.js" {
  interface SqliteStore {
    listWorkspaceCheckouts(workspaceId: string): WorktreeCheckout[];
    findWorkspaceCheckout(id: string): WorktreeCheckout | null;
    insertWorkspaceCheckout(checkout: WorktreeCheckout): void;
    updateWorkspaceCheckoutGate(id: string, gateStatus: WorktreeCheckout["gateStatus"]): WorktreeCheckout | null;
    updateWorkspaceCheckoutIssue(id: string, issue: IssueBinding | null): WorktreeCheckout | null;
    updateWorkspaceCheckoutPr(id: string, pr: PullRequestBinding | null): WorktreeCheckout | null;
    listWorkspacePlanVersions(workspaceId: string): WorkspacePlanVersion[];
    findActiveWorkspacePlan(workspaceId: string): WorkspacePlanVersion | null;
    insertWorkspacePlanVersion(plan: WorkspacePlanVersion): void;
    insertWorkspacePlanReview(review: WorkspacePlanReview): void;
    listWorkspacePlanReviews(planVersionId: string): WorkspacePlanReview[];
    insertWorkspacePlanDecision(decision: WorkspacePlanDecision): void;
    listWorkspacePlanDecisions(planVersionId: string): WorkspacePlanDecision[];
    insertWorkspaceManager(manager: WorkspaceManager): void;
    getWorkspaceManager(workspaceId: string): WorkspaceManager | null;
    setWorkspaceManagerPause(workspaceId: string, pauseState: WorkspaceManager["pauseState"]): WorkspaceManager | null;
    insertManagerEvent(event: ManagerEvent): void;
    listManagerEvents(workspaceId: string): ManagerEvent[];
    insertPlanDeviationReport(report: PlanDeviationReport): void;
    listPlanDeviationReports(workspaceId: string): PlanDeviationReport[];
    insertReviewArtifact(artifact: ReviewArtifact): void;
    listReviewArtifacts(checkoutId: string): ReviewArtifact[];
  }
}

function checkoutFromRow(row: Record<string, unknown>): WorktreeCheckout {
  return {
    id: asString(row, "id"),
    workspaceId: asString(row, "workspace_id"),
    repoId: asString(row, "repo_id"),
    name: asString(row, "name"),
    path: asString(row, "path"),
    branch: asString(row, "branch"),
    baseBranch: asString(row, "base_branch"),
    issue: row.issue_provider
      ? {
          provider: asString(row, "issue_provider"),
          key: asString(row, "issue_key"),
          url: row.issue_url ? asString(row, "issue_url") : null,
          title: row.issue_title ? asString(row, "issue_title") : null,
          status: row.issue_status ? asString(row, "issue_status") : null,
          fetchedAt: row.issue_fetched_at ? asString(row, "issue_fetched_at") : null,
        }
      : null,
    intendedPr: row.intended_pr_provider
      ? {
          provider: asString(row, "intended_pr_provider"),
          number:
            row.intended_pr_number === null || row.intended_pr_number === undefined
              ? null
              : Number(row.intended_pr_number),
          url: row.intended_pr_url ? asString(row, "intended_pr_url") : null,
          headSha: row.pr_head_sha ? asString(row, "pr_head_sha") : null,
          baseRef: row.pr_base_ref ? asString(row, "pr_base_ref") : null,
          fetchedAt: null,
        }
      : null,
    stackParentCheckoutId: row.stack_parent_checkout_id ? asString(row, "stack_parent_checkout_id") : null,
    inferredPurpose: row.inferred_purpose
      ? (asString(row, "inferred_purpose") as WorktreeCheckout["inferredPurpose"])
      : null,
    gateStatus: asString(row, "gate_status") as WorktreeCheckout["gateStatus"],
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
    archivedAt: row.archived_at ? asString(row, "archived_at") : null,
  };
}

function planVersionFromRow(row: Record<string, unknown>): WorkspacePlanVersion {
  return {
    id: asString(row, "id"),
    workspaceId: asString(row, "workspace_id"),
    version: Number(row.version),
    status: asString(row, "status") as WorkspacePlanVersion["status"],
    path: row.path ? asString(row, "path") : null,
    hash: asString(row, "hash"),
    active: Number(row.active) === 1,
    approvalMode: asString(row, "approval_mode") as WorkspacePlanVersion["approvalMode"],
    createdBySessionId: row.created_by_session_id ? asString(row, "created_by_session_id") : null,
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}

function planReviewFromRow(row: Record<string, unknown>): WorkspacePlanReview {
  return {
    id: asString(row, "id"),
    planVersionId: asString(row, "plan_version_id"),
    reviewer: asString(row, "reviewer"),
    result: asString(row, "result") as WorkspacePlanReview["result"],
    artifactPath: row.artifact_path ? asString(row, "artifact_path") : null,
    createdAt: asString(row, "created_at"),
  };
}

function planDecisionFromRow(row: Record<string, unknown>): WorkspacePlanDecision {
  return {
    id: asString(row, "id"),
    planVersionId: asString(row, "plan_version_id"),
    decision: asString(row, "decision") as WorkspacePlanDecision["decision"],
    reason: row.reason ? asString(row, "reason") : null,
    actor: asString(row, "actor") as WorkspacePlanDecision["actor"],
    createdAt: asString(row, "created_at"),
  };
}

function managerFromRow(row: Record<string, unknown>): WorkspaceManager {
  return {
    id: asString(row, "id"),
    workspaceId: asString(row, "workspace_id"),
    pauseState: asString(row, "pause_state") as WorkspaceManager["pauseState"],
    heartbeatIntervalSeconds: Number(row.heartbeat_interval_seconds),
    lastHeartbeatAt: row.last_heartbeat_at ? asString(row, "last_heartbeat_at") : null,
    createdAt: asString(row, "created_at"),
    updatedAt: asString(row, "updated_at"),
  };
}

function managerEventFromRow(row: Record<string, unknown>): ManagerEvent {
  return {
    id: asString(row, "id"),
    workspaceId: asString(row, "workspace_id"),
    managerId: asString(row, "manager_id"),
    type: asString(row, "type"),
    scopeKey: asString(row, "scope_key"),
    actionKey: row.action_key ? asString(row, "action_key") : null,
    idempotencyKey: asString(row, "idempotency_key"),
    status: asString(row, "status") as ManagerEvent["status"],
    message: row.message ? asString(row, "message") : null,
    createdAt: asString(row, "created_at"),
  };
}

function deviationFromRow(row: Record<string, unknown>): PlanDeviationReport {
  return {
    id: asString(row, "id"),
    workspaceId: asString(row, "workspace_id"),
    checkoutId: row.checkout_id ? asString(row, "checkout_id") : null,
    planVersionId: asString(row, "plan_version_id"),
    severity: asString(row, "severity") as PlanDeviationReport["severity"],
    description: asString(row, "description"),
    status: asString(row, "status") as PlanDeviationReport["status"],
    reportedBySessionId: row.reported_by_session_id ? asString(row, "reported_by_session_id") : null,
    createdAt: asString(row, "created_at"),
    resolvedAt: row.resolved_at ? asString(row, "resolved_at") : null,
  };
}

function reviewArtifactFromRow(row: Record<string, unknown>): ReviewArtifact {
  return {
    id: asString(row, "id"),
    workspaceId: asString(row, "workspace_id"),
    checkoutId: asString(row, "checkout_id"),
    planVersionId: asString(row, "plan_version_id"),
    prProvider: asString(row, "pr_provider"),
    prNumber: row.pr_number === null || row.pr_number === undefined ? null : Number(row.pr_number),
    prUrl: row.pr_url ? asString(row, "pr_url") : null,
    headSha: asString(row, "head_sha"),
    result: asString(row, "result") as ReviewArtifact["result"],
    findingsStatus: asString(row, "findings_status") as ReviewArtifact["findingsStatus"],
    blockingFindings: jsonArray(row, "blocking_findings"),
    artifactPath: row.artifact_path ? asString(row, "artifact_path") : null,
    createdAt: asString(row, "created_at"),
  };
}

export const agentsSystemStoreMethods = {
  listWorkspaceCheckouts(this: SqliteStore, workspaceId: string): WorktreeCheckout[] {
    const rows = this.database
      .prepare("SELECT * FROM workspace_checkouts WHERE workspace_id = ? AND archived_at IS NULL ORDER BY created_at")
      .all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map(checkoutFromRow);
  },

  findWorkspaceCheckout(this: SqliteStore, id: string): WorktreeCheckout | null {
    const row = this.database.prepare("SELECT * FROM workspace_checkouts WHERE id = ?").get(id);
    return row ? checkoutFromRow(row as Record<string, unknown>) : null;
  },

  insertWorkspaceCheckout(this: SqliteStore, checkout: WorktreeCheckout) {
    this.database
      .prepare(
        `INSERT INTO workspace_checkouts (id, workspace_id, repo_id, name, path, branch, base_branch,
          issue_provider, issue_key, issue_url, issue_title, issue_status, issue_fetched_at,
          intended_pr_provider, intended_pr_number, intended_pr_url,
          pr_head_sha, pr_base_ref, stack_parent_checkout_id, inferred_purpose, gate_status,
          created_at, updated_at, archived_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        checkout.id,
        checkout.workspaceId,
        checkout.repoId,
        checkout.name,
        checkout.path,
        checkout.branch,
        checkout.baseBranch,
        checkout.issue?.provider ?? null,
        checkout.issue?.key ?? null,
        checkout.issue?.url ?? null,
        checkout.issue?.title ?? null,
        checkout.issue?.status ?? null,
        checkout.issue?.fetchedAt ?? null,
        checkout.intendedPr?.provider ?? null,
        checkout.intendedPr?.number ?? null,
        checkout.intendedPr?.url ?? null,
        checkout.intendedPr?.headSha ?? null,
        checkout.intendedPr?.baseRef ?? null,
        checkout.stackParentCheckoutId ?? null,
        checkout.inferredPurpose ?? null,
        checkout.gateStatus,
        checkout.createdAt,
        checkout.updatedAt,
        checkout.archivedAt ?? null,
      );
  },

  updateWorkspaceCheckoutGate(
    this: SqliteStore,
    id: string,
    gateStatus: WorktreeCheckout["gateStatus"],
  ): WorktreeCheckout | null {
    this.database
      .prepare("UPDATE workspace_checkouts SET gate_status = ?, updated_at = ? WHERE id = ?")
      .run(gateStatus, new Date().toISOString(), id);
    return this.findWorkspaceCheckout(id);
  },

  updateWorkspaceCheckoutIssue(this: SqliteStore, id: string, issue: IssueBinding | null): WorktreeCheckout | null {
    this.database
      .prepare(
        `UPDATE workspace_checkouts
         SET issue_provider = ?, issue_key = ?, issue_url = ?, issue_title = ?, issue_status = ?, issue_fetched_at = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        issue?.provider ?? null,
        issue?.key ?? null,
        issue?.url ?? null,
        issue?.title ?? null,
        issue?.status ?? null,
        issue?.fetchedAt ?? null,
        new Date().toISOString(),
        id,
      );
    return this.findWorkspaceCheckout(id);
  },

  updateWorkspaceCheckoutPr(this: SqliteStore, id: string, pr: PullRequestBinding | null): WorktreeCheckout | null {
    this.database
      .prepare(
        `UPDATE workspace_checkouts
         SET intended_pr_provider = ?, intended_pr_number = ?, intended_pr_url = ?, pr_head_sha = ?, pr_base_ref = ?,
           updated_at = ?
         WHERE id = ?`,
      )
      .run(
        pr?.provider ?? null,
        pr?.number ?? null,
        pr?.url ?? null,
        pr?.headSha ?? null,
        pr?.baseRef ?? null,
        new Date().toISOString(),
        id,
      );
    return this.findWorkspaceCheckout(id);
  },

  listWorkspacePlanVersions(this: SqliteStore, workspaceId: string): WorkspacePlanVersion[] {
    const rows = this.database
      .prepare("SELECT * FROM workspace_plan_versions WHERE workspace_id = ? ORDER BY version DESC")
      .all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map(planVersionFromRow);
  },

  findActiveWorkspacePlan(this: SqliteStore, workspaceId: string): WorkspacePlanVersion | null {
    const row = this.database
      .prepare("SELECT * FROM workspace_plan_versions WHERE workspace_id = ? AND active = 1")
      .get(workspaceId);
    return row ? planVersionFromRow(row as Record<string, unknown>) : null;
  },

  insertWorkspacePlanVersion(this: SqliteStore, plan: WorkspacePlanVersion) {
    if (plan.active) {
      this.database
        .prepare(
          "UPDATE workspace_plan_versions SET active = 0, status = 'superseded', updated_at = ? WHERE workspace_id = ? AND active = 1",
        )
        .run(plan.updatedAt, plan.workspaceId);
    }
    this.database
      .prepare(
        `INSERT INTO workspace_plan_versions (id, workspace_id, version, status, path, hash, active,
          approval_mode, created_by_session_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        plan.id,
        plan.workspaceId,
        plan.version,
        plan.status,
        plan.path ?? null,
        plan.hash,
        plan.active ? 1 : 0,
        plan.approvalMode,
        plan.createdBySessionId ?? null,
        plan.createdAt,
        plan.updatedAt,
      );
  },

  insertWorkspacePlanReview(this: SqliteStore, review: WorkspacePlanReview) {
    this.database
      .prepare(
        `INSERT INTO workspace_plan_reviews (id, plan_version_id, reviewer, result, artifact_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        review.id,
        review.planVersionId,
        review.reviewer,
        review.result,
        review.artifactPath ?? null,
        review.createdAt,
      );
  },

  listWorkspacePlanReviews(this: SqliteStore, planVersionId: string): WorkspacePlanReview[] {
    const rows = this.database
      .prepare("SELECT * FROM workspace_plan_reviews WHERE plan_version_id = ? ORDER BY created_at DESC")
      .all(planVersionId) as Array<Record<string, unknown>>;
    return rows.map(planReviewFromRow);
  },

  insertWorkspacePlanDecision(this: SqliteStore, decision: WorkspacePlanDecision) {
    this.database
      .prepare(
        `INSERT INTO workspace_plan_decisions (id, plan_version_id, decision, reason, actor, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.id,
        decision.planVersionId,
        decision.decision,
        decision.reason ?? null,
        decision.actor,
        decision.createdAt,
      );
  },

  listWorkspacePlanDecisions(this: SqliteStore, planVersionId: string): WorkspacePlanDecision[] {
    const rows = this.database
      .prepare("SELECT * FROM workspace_plan_decisions WHERE plan_version_id = ? ORDER BY created_at DESC")
      .all(planVersionId) as Array<Record<string, unknown>>;
    return rows.map(planDecisionFromRow);
  },

  insertWorkspaceManager(this: SqliteStore, manager: WorkspaceManager) {
    this.database
      .prepare(
        `INSERT INTO workspace_managers (id, workspace_id, pause_state, heartbeat_interval_seconds,
          last_heartbeat_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        manager.id,
        manager.workspaceId,
        manager.pauseState,
        manager.heartbeatIntervalSeconds,
        manager.lastHeartbeatAt ?? null,
        manager.createdAt,
        manager.updatedAt,
      );
  },

  getWorkspaceManager(this: SqliteStore, workspaceId: string): WorkspaceManager | null {
    const row = this.database.prepare("SELECT * FROM workspace_managers WHERE workspace_id = ?").get(workspaceId);
    return row ? managerFromRow(row as Record<string, unknown>) : null;
  },

  setWorkspaceManagerPause(
    this: SqliteStore,
    workspaceId: string,
    pauseState: WorkspaceManager["pauseState"],
  ): WorkspaceManager | null {
    this.database
      .prepare("UPDATE workspace_managers SET pause_state = ?, updated_at = ? WHERE workspace_id = ?")
      .run(pauseState, new Date().toISOString(), workspaceId);
    return this.getWorkspaceManager(workspaceId);
  },

  insertManagerEvent(this: SqliteStore, event: ManagerEvent) {
    this.database
      .prepare(
        `INSERT OR IGNORE INTO manager_events (id, workspace_id, manager_id, type, scope_key, action_key,
          idempotency_key, status, message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.workspaceId,
        event.managerId,
        event.type,
        event.scopeKey,
        event.actionKey ?? null,
        event.idempotencyKey,
        event.status,
        event.message ?? null,
        event.createdAt,
      );
  },

  listManagerEvents(this: SqliteStore, workspaceId: string): ManagerEvent[] {
    const rows = this.database
      .prepare("SELECT * FROM manager_events WHERE workspace_id = ? ORDER BY created_at DESC")
      .all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map(managerEventFromRow);
  },

  insertPlanDeviationReport(this: SqliteStore, report: PlanDeviationReport) {
    this.database
      .prepare(
        `INSERT INTO plan_deviation_reports (id, workspace_id, checkout_id, plan_version_id, severity,
          description, status, reported_by_session_id, created_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        report.id,
        report.workspaceId,
        report.checkoutId ?? null,
        report.planVersionId,
        report.severity,
        report.description,
        report.status,
        report.reportedBySessionId ?? null,
        report.createdAt,
        report.resolvedAt ?? null,
      );
  },

  listPlanDeviationReports(this: SqliteStore, workspaceId: string): PlanDeviationReport[] {
    const rows = this.database
      .prepare("SELECT * FROM plan_deviation_reports WHERE workspace_id = ? ORDER BY created_at DESC")
      .all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map(deviationFromRow);
  },

  insertReviewArtifact(this: SqliteStore, artifact: ReviewArtifact) {
    this.database
      .prepare(
        `INSERT OR REPLACE INTO checkout_review_artifacts (id, workspace_id, checkout_id, plan_version_id,
          pr_provider, pr_number, pr_url, head_sha, result, findings_status, blocking_findings, artifact_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        artifact.id,
        artifact.workspaceId,
        artifact.checkoutId,
        artifact.planVersionId,
        artifact.prProvider,
        artifact.prNumber ?? null,
        artifact.prUrl ?? null,
        artifact.headSha,
        artifact.result,
        artifact.findingsStatus,
        JSON.stringify(artifact.blockingFindings),
        artifact.artifactPath ?? null,
        artifact.createdAt,
      );
  },

  listReviewArtifacts(this: SqliteStore, checkoutId: string): ReviewArtifact[] {
    const rows = this.database
      .prepare("SELECT * FROM checkout_review_artifacts WHERE checkout_id = ? ORDER BY created_at DESC")
      .all(checkoutId) as Array<Record<string, unknown>>;
    return rows.map(reviewArtifactFromRow);
  },
};
