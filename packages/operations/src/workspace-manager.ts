import path from "node:path";
import type {
  ActivityEvent,
  CheckoutContextInput,
  CheckoutGateStatus,
  IssueBinding,
  ManagerEvent,
  MarkCheckoutReadyForReviewInput,
  RegisterCheckoutReviewArtifactInput,
  ReviewArtifact,
  UpdateTicketStatusInput,
  Workspace,
  WorkspaceManager,
  WorkspacePlanVersion,
  WorktreeCheckout,
} from "@citadel/contracts";
import { createId, nowIso } from "@citadel/core";
import type { SqliteStore } from "@citadel/db";
import { resolveExecutionTargetForCwd } from "./workspace-layout.js";

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
  | { ok: false; error: CheckoutResolveError | "active_plan_required" | "pr_required" | "pr_head_sha_required" };

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
): RegisterCheckoutReviewArtifactResult {
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
  const existing = deps.store
    .listReviewArtifacts(checkout.id)
    .find((artifact) => artifact.planVersionId === activePlan.id && artifact.headSha === pr.headSha);
  const artifact: ReviewArtifact =
    existing ??
    ({
      id: createId("review"),
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
      createdAt: nowIso(),
    } satisfies ReviewArtifact);
  if (!existing) deps.store.insertReviewArtifact(artifact);
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
  if (input.checkoutId && !checkout) return { ok: false, error: "checkout_not_found" as const };
  if (checkout && checkout.workspaceId !== input.workspaceId)
    return { ok: false, error: "checkout_not_found" as const };
  const issue: IssueBinding = { ...input.issue, status: input.targetState };
  const updated = checkout ? deps.store.updateWorkspaceCheckoutIssue(checkout.id, issue) : null;
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
    checkout: updated,
  };
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
