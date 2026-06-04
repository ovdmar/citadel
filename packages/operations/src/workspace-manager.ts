import path from "node:path";
import type {
  ActivityEvent,
  AgentSession,
  CheckoutContextInput,
  CheckoutGateStatus,
  IssueBinding,
  LocalNotificationEvent,
  ManagerActionLedgerEntry,
  ManagerEvent,
  MarkCheckoutReadyForReviewInput,
  RegisterCheckoutReviewArtifactInput,
  ReviewArtifact,
  UpdateTicketStatusInput,
  Workspace,
  WorkspaceManager,
  WorkspacePlanDeliveryUnit,
  WorkspacePlanVersion,
  WorktreeCheckout,
} from "@citadel/contracts";
import { createId, nowIso } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import { type ManagerDecision, evaluateManagerDecisions } from "./manager-decision.js";
import { stableId } from "./stable-id.js";
import { resolveExecutionTargetForCwd } from "./workspace-layout.js";
import { issueFactFromBinding, prFactFromBinding } from "./workspace-manager-provider-facts.js";

export type WorkspaceManagerDeps = {
  store: SqliteStore;
  activity: (
    type: string,
    source: ActivityEvent["source"],
    message: string,
    repoId: string | null,
    workspaceId: string | null,
    operationId: string | null,
  ) => void;
};

export type TrustedToolActor = "human" | "manager" | "agent" | "mcp" | "system";

export type WorkspaceManagerControlResult =
  | { ok: true; manager: WorkspaceManager; created?: boolean }
  | { ok: false; error: "workspace_not_found" | "structured_workspace_required" | "manager_not_found" };

type CheckoutResolveError = "checkout_required" | "checkout_not_found" | "workspace_not_found" | "cwd_not_registered";

export type CheckoutGateSnapshot =
  | {
      ok: true;
      workspace: Workspace;
      checkout: WorktreeCheckout;
      status: CheckoutGateStatus;
      reasons: string[];
      activePlan: WorkspacePlanVersion | null;
      currentReview: ReviewArtifact | null;
      stackParent: WorktreeCheckout | null;
      downstreamCheckouts: WorktreeCheckout[];
    }
  | { ok: false; error: CheckoutResolveError };

type ResolvedCheckout =
  | { ok: true; workspace: Workspace; checkout: WorktreeCheckout; cwd?: string }
  | { ok: false; error: CheckoutResolveError };

export type MarkCheckoutReadyForReviewResult =
  | { ok: true; checkout: WorktreeCheckout; gate: CheckoutGateSnapshot }
  | { ok: false; error: CheckoutResolveError | "active_plan_required" | "pr_required" | "pr_head_sha_required" };

export type RegisterCheckoutReviewArtifactResult =
  | { ok: true; artifact: ReviewArtifact; gate: CheckoutGateSnapshot }
  | {
      ok: false;
      error:
        | CheckoutResolveError
        | "active_plan_required"
        | "pr_required"
        | "pr_head_sha_required"
        | "review_authority_required"
        | "review_action_mismatch"
        | "human_waiver_required";
    };

export type WorkspaceManagerTickResult =
  | {
      ok: true;
      workspace: Workspace;
      manager: WorkspaceManager;
      decisions: ManagerDecision[];
      actions: ManagerActionLedgerEntry[];
      boundCheckouts: number;
      providerFacts: { issues: number; prs: number };
      notifications: number;
      supersededActions: number;
    }
  | { ok: false; error: "workspace_not_found" | "structured_workspace_required" | "manager_not_found" };

const PROVIDER_FACT_FRESH_MS = 15 * 60 * 1000;

export function startWorkspaceManager(
  deps: WorkspaceManagerDeps,
  input: { workspaceId: string },
): WorkspaceManagerControlResult {
  const workspace = deps.store.listWorkspaces().find((candidate) => candidate.id === input.workspaceId);
  if (!workspace) return { ok: false, error: "workspace_not_found" as const };
  if (workspace.mode !== "structured") return { ok: false, error: "structured_workspace_required" as const };
  const existing = deps.store.getWorkspaceManager(workspace.id);
  if (existing) return { ok: true, manager: existing, created: false };
  const now = nowIso();
  const manager: WorkspaceManager = {
    id: createId("mgr"),
    workspaceId: workspace.id,
    pauseState: "running",
    heartbeatIntervalSeconds: 300,
    lastHeartbeatAt: null,
    createdAt: now,
    updatedAt: now,
  };
  deps.store.insertWorkspaceManager(manager);
  deps.activity("workspace.manager.started", "mcp", "Started workspace manager", workspace.repoId, workspace.id, null);
  return { ok: true, manager, created: true };
}

export function pauseWorkspaceManager(
  deps: WorkspaceManagerDeps,
  input: { workspaceId: string },
): WorkspaceManagerControlResult {
  return setManagerPause(deps, input.workspaceId, "paused");
}

export function resumeWorkspaceManager(
  deps: WorkspaceManagerDeps,
  input: { workspaceId: string },
): WorkspaceManagerControlResult {
  return setManagerPause(deps, input.workspaceId, "running");
}

export function runWorkspaceManagerTick(
  deps: WorkspaceManagerDeps,
  input: { workspaceId: string; leaseOwnerId?: string; leaseSeconds?: number },
): WorkspaceManagerTickResult {
  const workspace = deps.store.listWorkspaces().find((candidate) => candidate.id === input.workspaceId);
  if (!workspace) return { ok: false, error: "workspace_not_found" as const };
  if (workspace.mode !== "structured") return { ok: false, error: "structured_workspace_required" as const };
  const manager = deps.store.getWorkspaceManager(workspace.id);
  if (!manager) return { ok: false, error: "manager_not_found" as const };
  const now = nowIso();
  const activePlan = deps.store.findActiveWorkspacePlan(workspace.id);
  const deliveryUnits = activePlan ? deps.store.listWorkspacePlanDeliveryUnits(activePlan.id) : [];
  const expired = deps.store.reconcileManagerActions(now);
  const expiredForWorkspace = expired.filter((entry) => entry.workspaceId === workspace.id);
  for (const action of expiredForWorkspace) {
    if (action.leaseOwnerId) {
      deps.store.reconcileExpiredManagerAction(action.id, action.leaseOwnerId, action.leaseGeneration, now);
    }
  }

  const boundCheckouts = activePlan ? bindExistingDeliveryUnitCheckouts(deps, workspace, activePlan, deliveryUnits) : 0;
  const providerFacts = syncLocalProviderFacts(deps, workspace, deliveryUnits, now);
  const checkouts = deps.store.listWorkspaceCheckouts(workspace.id);
  const gates = checkouts.flatMap((checkout) => {
    const gate = getCheckoutGateStatus(deps, { checkoutId: checkout.id });
    return gate.ok ? [{ checkoutId: checkout.id, status: gate.status, reasons: gate.reasons }] : [];
  });
  const decisions = evaluateManagerDecisions({
    workspaceId: workspace.id,
    manager,
    activePlan,
    deliveryUnits,
    checkouts,
    sessions: deps.store
      .listWorkspaceSessions()
      .filter((session): session is AgentSession => session.workspaceId === workspace.id && session.kind === "agent"),
    gates,
  });
  const actions: ManagerActionLedgerEntry[] = [];
  let notifications = 0;
  for (const decision of decisions) {
    const action = deps.store.claimManagerAction(actionFromDecision(decision, workspace.id, manager.id, now, input));
    actions.push(action);
    if (
      decision.actionName === "notify_human_input_needed" ||
      decision.actionName === "notify_ready_for_human_review"
    ) {
      deps.store.upsertLocalNotificationEvent(notificationFromDecision(decision, workspace.id, action.id, now));
      notifications += 1;
    }
    recordManagerDecisionEvent(deps, workspace, manager, decision, action, now);
  }
  return {
    ok: true,
    workspace,
    manager,
    decisions,
    actions,
    boundCheckouts,
    providerFacts,
    notifications,
    supersededActions: expiredForWorkspace.length,
  };
}

export function getCheckoutGateStatus(
  deps: Pick<WorkspaceManagerDeps, "store">,
  input: CheckoutContextInput,
): CheckoutGateSnapshot {
  const resolved = resolveCheckout(deps.store, input);
  if (!resolved.ok) return resolved;
  const { workspace, checkout } = resolved;
  const activePlan = deps.store.findActiveWorkspacePlan(workspace.id);
  const currentPr = checkout.intendedPr;
  const currentHead = currentPr?.headSha ?? null;
  const artifacts = deps.store.listReviewArtifacts(checkout.id);
  const currentReview =
    currentHead && activePlan
      ? (artifacts.find(
          (artifact) =>
            artifact.headSha === currentHead && artifact.planVersionId === activePlan.id && !artifact.invalidatedAt,
        ) ?? null)
      : null;
  const openDeviations = deps.store
    .listPlanDeviationReports(workspace.id)
    .filter(
      (report) =>
        report.status === "open" &&
        report.severity === "blocking" &&
        (report.checkoutId === null || report.checkoutId === checkout.id),
    );
  const checkouts = deps.store.listWorkspaceCheckouts(workspace.id);
  const stackParent = checkout.stackParentCheckoutId
    ? deps.store.findWorkspaceCheckout(checkout.stackParentCheckoutId)
    : null;
  const downstreamCheckouts = checkouts.filter((candidate) => candidate.stackParentCheckoutId === checkout.id);
  const reasons: string[] = [];
  let status: CheckoutGateStatus = checkout.gateStatus;

  if (stackParent && stackParent.gateStatus !== "ready_for_human_review" && stackParent.gateStatus !== "done") {
    status = "blocked";
    reasons.push(`stack_parent_not_ready:${stackParent.id}`);
  } else if (!activePlan) {
    status = "blocked";
    reasons.push("active_plan_required");
  } else if (!currentPr?.provider || (!currentPr.number && !currentPr.url)) {
    status = "waiting_for_pr";
    reasons.push("pr_required");
  } else if (!currentHead) {
    status = "review_required";
    reasons.push("pr_head_sha_required");
  } else if (!currentPr.fetchedAt || !isFreshIso(currentPr.fetchedAt)) {
    status = "stale_provider";
    reasons.push("stale_provider_facts");
  } else if (
    currentPr.hasConflicts ||
    currentPr.mergeStateStatus === "DIRTY" ||
    currentPr.mergeStateStatus === "CONFLICTING"
  ) {
    status = "conflicts";
    reasons.push("pr_conflicts");
  } else if (currentPr.checksGreen !== true) {
    status = currentPr.checksGreen === false ? "checks_failing" : "checks_pending";
    reasons.push(currentPr.checksGreen === false ? "checks_failing" : "checks_pending");
  } else if (openDeviations.length) {
    status = "blocked";
    reasons.push("open_plan_deviation");
  } else if (!currentReview) {
    status = "review_required";
    reasons.push("review_pr_artifact_required");
  } else if (
    currentReview.result === "failed" ||
    currentReview.result === "request_changes" ||
    currentReview.findingsStatus === "open_blocking"
  ) {
    status = "review_blocked";
    reasons.push("blocking_review_findings");
  } else if (
    currentReview.findingsStatus === "waived" &&
    (!currentReview.humanWaivedAt || !currentReview.humanWaivedBy || !currentReview.humanWaiverReason)
  ) {
    status = "review_blocked";
    reasons.push("human_waiver_required");
  } else {
    status = "ready_for_human_review";
    reasons.push("ready");
  }

  return {
    ok: true,
    workspace,
    checkout,
    status,
    reasons,
    activePlan,
    currentReview,
    stackParent,
    downstreamCheckouts,
  };
}

export function markCheckoutReadyForReview(
  deps: WorkspaceManagerDeps,
  input: MarkCheckoutReadyForReviewInput,
): MarkCheckoutReadyForReviewResult {
  const resolved = resolveCheckout(deps.store, { checkoutId: input.checkoutId });
  if (!resolved.ok) return resolved;
  const activePlan = deps.store.findActiveWorkspacePlan(resolved.workspace.id);
  if (!activePlan) return { ok: false, error: "active_plan_required" as const };
  const checkout = input.pr ? deps.store.updateWorkspaceCheckoutPr(input.checkoutId, input.pr) : resolved.checkout;
  if (!checkout) return { ok: false, error: "checkout_not_found" as const };
  const pr = checkout.intendedPr;
  if (!pr?.provider || (!pr.number && !pr.url)) return { ok: false, error: "pr_required" as const };
  if (!pr.headSha) return { ok: false, error: "pr_head_sha_required" as const };
  deps.store.invalidateCheckoutReviewArtifacts(checkout.id, "head_changed", pr.headSha);
  const gate = getCheckoutGateStatus(deps, { checkoutId: checkout.id });
  if (gate.ok) {
    deps.store.updateWorkspaceCheckoutGate(checkout.id, gate.status);
  }
  deps.activity(
    "checkout.implementation.completed",
    input.sessionId ? "agent" : "mcp",
    input.notes ?? `Recorded implementation completion for ${checkout.name}`,
    resolved.workspace.repoId,
    resolved.workspace.id,
    null,
  );
  return { ok: true, checkout, gate };
}

export function registerCheckoutReviewArtifact(
  deps: WorkspaceManagerDeps,
  input: RegisterCheckoutReviewArtifactInput,
  options: { actor?: TrustedToolActor } = {},
): RegisterCheckoutReviewArtifactResult {
  const actor = options.actor ?? "human";
  const resolved = resolveCheckout(deps.store, { checkoutId: input.checkoutId });
  if (!resolved.ok) return resolved;
  const activePlan = input.planVersionId
    ? deps.store.listWorkspacePlanVersions(resolved.workspace.id).find((plan) => plan.id === input.planVersionId)
    : deps.store.findActiveWorkspacePlan(resolved.workspace.id);
  if (!activePlan) return { ok: false, error: "active_plan_required" as const };
  const checkout = input.pr ? deps.store.updateWorkspaceCheckoutPr(input.checkoutId, input.pr) : resolved.checkout;
  if (!checkout) return { ok: false, error: "checkout_not_found" as const };
  const pr = checkout.intendedPr;
  if (!pr?.provider || (!pr.number && !pr.url)) return { ok: false, error: "pr_required" as const };
  if (!pr.headSha) return { ok: false, error: "pr_head_sha_required" as const };
  if (input.findingsStatus === "waived" && (!input.humanWaivedBy || !input.humanWaiverReason))
    return { ok: false, error: "human_waiver_required" as const };
  if (input.findingsStatus === "waived" && actor !== "human")
    return { ok: false, error: "human_waiver_required" as const };
  const authority = validateReviewArtifactAuthority(deps, input, activePlan, checkout, pr.headSha, actor);
  if (!authority.ok) return authority;
  deps.store.invalidateCheckoutReviewArtifacts(checkout.id, "head_changed", pr.headSha);
  const existing = deps.store
    .listReviewArtifacts(checkout.id)
    .find(
      (artifact) =>
        artifact.planVersionId === activePlan.id && artifact.headSha === pr.headSha && !artifact.invalidatedAt,
    );
  const now = nowIso();
  const artifact: ReviewArtifact = {
    id: existing?.id ?? createId("review"),
    workspaceId: resolved.workspace.id,
    checkoutId: checkout.id,
    planVersionId: activePlan.id,
    prProvider: pr.provider,
    prNumber: pr.number ?? null,
    prUrl: pr.url ?? null,
    headSha: pr.headSha,
    result: input.result,
    findingsStatus: input.findingsStatus,
    blockingFindings: input.blockingFindings,
    artifactPath: input.artifactPath,
    invalidatedAt: null,
    invalidatedReason: null,
    humanWaivedAt: input.findingsStatus === "waived" ? now : null,
    humanWaivedBy: input.findingsStatus === "waived" ? (input.humanWaivedBy ?? null) : null,
    humanWaiverReason: input.findingsStatus === "waived" ? (input.humanWaiverReason ?? null) : null,
    createdAt: existing?.createdAt ?? now,
  };
  deps.store.insertReviewArtifact(artifact);
  const gate = getCheckoutGateStatus(deps, { checkoutId: checkout.id });
  if (gate.ok) {
    deps.store.updateWorkspaceCheckoutGate(checkout.id, gate.status);
    if (gate.status === "ready_for_human_review") {
      recordReadyNotification(deps, resolved.workspace, checkout, activePlan, pr.headSha);
    }
  }
  deps.activity(
    "checkout.review.artifact.registered",
    input.sessionId ? "agent" : "mcp",
    input.notes ?? `Registered review artifact for ${checkout.name}`,
    resolved.workspace.repoId,
    resolved.workspace.id,
    null,
  );
  return { ok: true, artifact, gate };
}

export function updateTicketStatus(deps: WorkspaceManagerDeps, input: UpdateTicketStatusInput) {
  const checkout = input.checkoutId ? deps.store.findWorkspaceCheckout(input.checkoutId) : null;
  if (input.checkoutId && (!checkout || checkout.workspaceId !== input.workspaceId))
    return { ok: false, error: "checkout_not_found" as const };
  const workspace = deps.store.listWorkspaces().find((candidate) => candidate.id === input.workspaceId);
  if (!workspace) return { ok: false, error: "workspace_not_found" as const };
  const issue: IssueBinding = { ...input.issue, status: input.targetState };
  const updatedCheckout = checkout ? deps.store.updateWorkspaceCheckoutIssue(checkout.id, issue) : null;
  const updatedWorkspace = checkout ? null : deps.store.updateWorkspaceParentIssue(workspace.id, issue);
  deps.activity(
    "ticket.status.updated",
    "mcp",
    `Updated ${issue.provider}:${issue.key} to ${input.targetState}`,
    null,
    input.workspaceId,
    null,
  );
  return {
    ok: true,
    provider: issue.provider,
    externalUpdate: "not_configured",
    issue,
    checkout: updatedCheckout,
    workspace: updatedWorkspace,
  };
}

function validateReviewArtifactAuthority(
  deps: WorkspaceManagerDeps,
  input: RegisterCheckoutReviewArtifactInput,
  plan: WorkspacePlanVersion,
  checkout: WorktreeCheckout,
  headSha: string,
  actor: TrustedToolActor,
): { ok: true } | { ok: false; error: "review_authority_required" | "review_action_mismatch" } {
  if (!input.sessionId && !input.managerActionId) {
    return actor === "human" ? { ok: true } : { ok: false, error: "review_authority_required" };
  }
  const session = input.sessionId
    ? deps.store.listWorkspaceSessions().find((candidate) => candidate.id === input.sessionId)
    : null;
  if (input.sessionId) {
    if (!session || session.kind !== "agent") return { ok: false, error: "review_authority_required" as const };
    if (
      session.checkoutId !== checkout.id ||
      session.planVersionId !== plan.id ||
      session.role !== "implementation" ||
      session.actionId !== "implementation.review_pr"
    ) {
      return { ok: false, error: "review_action_mismatch" as const };
    }
    if (input.managerActionId && session.managerActionId !== input.managerActionId) {
      return { ok: false, error: "review_action_mismatch" as const };
    }
  }
  const managerActionId = input.managerActionId ?? session?.managerActionId ?? null;
  if (!managerActionId) return input.sessionId ? { ok: true } : { ok: false, error: "review_authority_required" };
  const action = deps.store
    .listManagerActions(checkout.workspaceId)
    .find((candidate) => candidate.id === managerActionId);
  if (!action) return { ok: false, error: "review_authority_required" as const };
  if (
    action.actionName !== "run_review_pr" ||
    action.checkoutId !== checkout.id ||
    action.planVersionId !== plan.id ||
    action.prHeadSha !== headSha ||
    action.status === "superseded" ||
    action.status === "abandoned"
  ) {
    return { ok: false, error: "review_action_mismatch" as const };
  }
  return { ok: true };
}

function bindExistingDeliveryUnitCheckouts(
  deps: WorkspaceManagerDeps,
  workspace: Workspace,
  plan: WorkspacePlanVersion,
  deliveryUnits: WorkspacePlanDeliveryUnit[],
): number {
  let bound = 0;
  for (const unit of deliveryUnits) {
    const checkouts = deps.store.listWorkspaceCheckouts(workspace.id);
    if (
      checkouts.some((checkout) => checkout.deliveryPlanVersionId === plan.id && checkout.deliveryUnitKey === unit.key)
    ) {
      continue;
    }
    const matches = checkouts.filter(
      (checkout) =>
        !checkout.deliveryUnitKey &&
        checkout.name === unit.checkoutName &&
        Boolean(unit.childIssue) &&
        Boolean(checkout.issue) &&
        issueMatches(checkout.issue, unit.childIssue),
    );
    if (matches.length === 1 && matches[0]) {
      deps.store.updateWorkspaceCheckoutDeliveryUnit(matches[0].id, {
        deliveryPlanVersionId: plan.id,
        deliveryUnitKey: unit.key,
      });
      bound += 1;
    }
  }
  return bound;
}

function syncLocalProviderFacts(
  deps: WorkspaceManagerDeps,
  workspace: Workspace,
  deliveryUnits: WorkspacePlanDeliveryUnit[],
  timestamp: string,
): { issues: number; prs: number } {
  let issues = 0;
  let prs = 0;
  if (workspace.parentIssue) {
    deps.store.upsertProviderIssueFact(issueFactFromBinding(workspace, null, null, workspace.parentIssue, timestamp));
    issues += 1;
  }
  for (const unit of deliveryUnits) {
    if (unit.childIssue) {
      deps.store.upsertProviderIssueFact(issueFactFromBinding(workspace, null, unit.key, unit.childIssue, timestamp));
      issues += 1;
    }
  }
  for (const checkout of deps.store.listWorkspaceCheckouts(workspace.id)) {
    if (checkout.issue) {
      deps.store.upsertProviderIssueFact(
        issueFactFromBinding(workspace, checkout, checkout.deliveryUnitKey, checkout.issue, timestamp),
      );
      issues += 1;
    }
    if (checkout.intendedPr) {
      deps.store.upsertCheckoutPrFact(prFactFromBinding(workspace, checkout, timestamp));
      prs += 1;
    }
  }
  return { issues, prs };
}

function actionFromDecision(
  decision: ManagerDecision,
  workspaceId: string,
  managerId: string,
  timestamp: string,
  input: { leaseOwnerId?: string; leaseSeconds?: number },
): ManagerActionLedgerEntry {
  const leaseOwnerId = input.leaseOwnerId ?? null;
  const leaseExpiresAt =
    leaseOwnerId && input.leaseSeconds
      ? new Date(Date.parse(timestamp) + input.leaseSeconds * 1000).toISOString()
      : null;
  return {
    id: stableId("act", decision.idempotencyKey),
    workspaceId,
    checkoutId: decision.checkoutId,
    managerId,
    actionName: decision.actionName,
    status: leaseOwnerId ? "claimed" : "queued",
    scopeKey: decision.scopeKey,
    actionKey: decision.actionKey,
    factKey: decision.factKey,
    idempotencyKey: decision.idempotencyKey,
    leaseOwnerId,
    leaseGeneration: leaseOwnerId ? 1 : 0,
    leaseExpiresAt,
    attemptCount: leaseOwnerId ? 1 : 0,
    maxAttempts: 3,
    operationId: null,
    sessionId: null,
    artifactId: null,
    prHeadSha: decision.prHeadSha,
    planVersionId: decision.planVersionId,
    claimedAt: leaseOwnerId ? timestamp : null,
    completedAt: null,
    lastReconciledAt: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function notificationFromDecision(
  decision: ManagerDecision,
  workspaceId: string,
  managerActionId: string,
  timestamp: string,
): LocalNotificationEvent {
  const type =
    decision.actionName === "notify_ready_for_human_review" ? "ready_for_human_review" : "human_input_needed";
  return {
    id: stableId("note", decision.idempotencyKey),
    workspaceId,
    checkoutId: decision.checkoutId,
    type,
    status: "active",
    title: decision.title,
    message: decision.message,
    dedupeKey: decision.idempotencyKey,
    triggeringFactFingerprint: decision.factKey ?? decision.idempotencyKey,
    managerActionId,
    resolvedAt: null,
    rearmedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function recordManagerDecisionEvent(
  deps: WorkspaceManagerDeps,
  workspace: Workspace,
  manager: WorkspaceManager,
  decision: ManagerDecision,
  action: ManagerActionLedgerEntry,
  timestamp: string,
) {
  if (deps.store.listManagerEvents(workspace.id).some((event) => event.idempotencyKey === decision.idempotencyKey))
    return;
  deps.store.insertManagerEvent({
    id: stableId("mevt", decision.idempotencyKey),
    workspaceId: workspace.id,
    managerId: manager.id,
    type: "manager_decision",
    scopeKey: decision.scopeKey,
    actionKey: decision.actionKey,
    idempotencyKey: decision.idempotencyKey,
    status: managerEventStatus(action.status),
    message: decision.message,
    createdAt: timestamp,
  });
}

function issueMatches(left: IssueBinding | null | undefined, right: IssueBinding | null | undefined): boolean {
  return Boolean(left && right && left.provider === right.provider && left.key === right.key);
}

function managerEventStatus(status: ManagerActionLedgerEntry["status"]): ManagerEvent["status"] {
  if (status === "queued") return "queued";
  if (status === "succeeded") return "succeeded";
  if (status === "failed" || status === "blocked") return "failed";
  if (status === "superseded" || status === "abandoned") return "skipped";
  return "running";
}

function isFreshIso(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && Date.now() - parsed <= PROVIDER_FACT_FRESH_MS;
}

function setManagerPause(
  deps: WorkspaceManagerDeps,
  workspaceId: string,
  pauseState: WorkspaceManager["pauseState"],
): WorkspaceManagerControlResult {
  const manager = deps.store.getWorkspaceManager(workspaceId);
  if (!manager) return { ok: false, error: "manager_not_found" as const };
  const updated = deps.store.setWorkspaceManagerPause(workspaceId, pauseState) ?? manager;
  deps.activity(
    pauseState === "paused" ? "workspace.manager.paused" : "workspace.manager.resumed",
    "mcp",
    pauseState === "paused" ? "Paused workspace manager" : "Resumed workspace manager",
    null,
    workspaceId,
    null,
  );
  return { ok: true, manager: updated };
}

function recordReadyNotification(
  deps: WorkspaceManagerDeps,
  workspace: Workspace,
  checkout: WorktreeCheckout,
  plan: WorkspacePlanVersion,
  headSha: string,
) {
  const manager = deps.store.getWorkspaceManager(workspace.id);
  if (!manager) return;
  const now = nowIso();
  const idempotencyKey = `ready_for_review:${checkout.id}:${headSha}:${plan.id}`;
  if (deps.store.listManagerEvents(workspace.id).some((event) => event.idempotencyKey === idempotencyKey)) return;
  const event: ManagerEvent = {
    id: createId("mevt"),
    workspaceId: workspace.id,
    managerId: manager.id,
    type: "local_notification",
    scopeKey: `checkout:${checkout.id}`,
    actionKey: "manager.notify_ready_for_human_review",
    idempotencyKey,
    status: "succeeded",
    message: `${checkout.name} is ready for human review`,
    createdAt: now,
  };
  deps.store.insertManagerEvent(event);
  deps.activity(
    "notification.ready_for_human_review",
    "system",
    event.message ?? "Checkout ready for human review",
    workspace.repoId,
    workspace.id,
    null,
  );
}

function resolveCheckout(store: SqliteStore, input: CheckoutContextInput): ResolvedCheckout {
  if (input.checkoutId) {
    const checkout = store.findWorkspaceCheckout(input.checkoutId);
    if (!checkout) return { ok: false, error: "checkout_not_found" as const };
    const workspace = store.listWorkspaces().find((candidate) => candidate.id === checkout.workspaceId);
    if (!workspace) return { ok: false, error: "workspace_not_found" as const };
    return { ok: true, workspace, checkout };
  }
  if (!input.cwd) return { ok: false, error: "checkout_required" as const };
  const workspaces = store.listWorkspaces();
  const checkouts = workspaces.flatMap((workspace) => store.listWorkspaceCheckouts(workspace.id));
  const target = resolveExecutionTargetForCwd({ cwd: input.cwd, workspaces, checkouts });
  if (!target.ok) return { ok: false, error: "cwd_not_registered" as const };
  const resolvedTarget = target.target;
  if (resolvedTarget.type !== "worktree_checkout") return { ok: false, error: "checkout_required" as const };
  const checkout = checkouts.find((candidate) => candidate.id === resolvedTarget.checkoutId);
  if (!checkout) return { ok: false, error: "checkout_not_found" as const };
  const workspace = workspaces.find((candidate) => candidate.id === resolvedTarget.workspaceId);
  if (!workspace) return { ok: false, error: "workspace_not_found" as const };
  return { ok: true, workspace, checkout, cwd: path.resolve(input.cwd) };
}
