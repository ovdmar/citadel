import type {
  AgentSession,
  CheckoutGateStatus,
  ManagerActionName,
  WorkspaceManager,
  WorkspacePlanDeliveryUnit,
  WorkspacePlanDependencyEdgeType,
  WorkspacePlanVersion,
  WorktreeCheckout,
} from "@citadel/contracts";

export type ManagerDecision = {
  actionName: ManagerActionName;
  scopeKey: string;
  actionKey: string;
  factKey: string | null;
  idempotencyKey: string;
  checkoutId: string | null;
  planVersionId: string | null;
  deliveryUnitKey: string | null;
  prHeadSha: string | null;
  title: string;
  message: string;
  automated: boolean;
};

export type ManagerGateInput = {
  checkoutId: string;
  status: CheckoutGateStatus;
  reasons: string[];
};

export function evaluateManagerDecisions(input: {
  workspaceId: string;
  manager: WorkspaceManager | null;
  activePlan: WorkspacePlanVersion | null;
  deliveryUnits: WorkspacePlanDeliveryUnit[];
  checkouts: WorktreeCheckout[];
  sessions: AgentSession[];
  gates: ManagerGateInput[];
}): ManagerDecision[] {
  const plan = input.activePlan;
  if (!plan || plan.status !== "approved" || !plan.active) {
    return [humanInput(input.workspaceId, null, null, "active_plan_required", "Approved plan required")];
  }
  if (input.deliveryUnits.length === 0) {
    return [
      humanInput(input.workspaceId, plan.id, null, "plan_delivery_units_required", "Plan delivery units required"),
    ];
  }

  const managerRunning = input.manager?.pauseState === "running";
  const decisions: ManagerDecision[] = [];
  const gatesByCheckout = new Map(input.gates.map((gate) => [gate.checkoutId, gate]));
  for (const unit of input.deliveryUnits) {
    const checkout = findDeliveryUnitCheckout(input.checkouts, plan.id, unit.key);
    const dependencyBlock = blockingDependency(unit, input.checkouts, gatesByCheckout);
    if (dependencyBlock) {
      decisions.push(
        humanInput(
          input.workspaceId,
          plan.id,
          checkout?.id ?? null,
          `${unit.key}:${dependencyBlock.type}:${dependencyBlock.fromUnitKey}`,
          dependencyBlock.message,
          unit.key,
        ),
      );
      continue;
    }

    if (!checkout) {
      if (managerRunning) {
        decisions.push({
          actionName: "create_checkout",
          scopeKey: `workspace:${input.workspaceId}`,
          actionKey: `create_checkout:${unit.key}`,
          factKey: `plan:${plan.id}:unit:${unit.key}`,
          idempotencyKey: `${input.workspaceId}:${plan.id}:${unit.key}:create_checkout`,
          checkoutId: null,
          planVersionId: plan.id,
          deliveryUnitKey: unit.key,
          prHeadSha: null,
          title: "Create checkout",
          message: `Create checkout ${unit.checkoutName} for delivery unit ${unit.key}`,
          automated: true,
        });
      }
      continue;
    }

    const gate = gatesByCheckout.get(checkout.id);
    const prHeadSha = checkout.intendedPr?.headSha ?? null;
    if (!checkout.issue) {
      decisions.push(
        humanInput(
          input.workspaceId,
          plan.id,
          checkout.id,
          `${unit.key}:child_issue_required`,
          `Checkout ${checkout.name} needs a child issue binding`,
          unit.key,
        ),
      );
      continue;
    }
    if (gate?.status === "ready_for_human_review" && prHeadSha) {
      decisions.push({
        actionName: "notify_ready_for_human_review",
        scopeKey: `checkout:${checkout.id}`,
        actionKey: "notify_ready_for_human_review",
        factKey: `pr_head:${prHeadSha}`,
        idempotencyKey: `${checkout.id}:${plan.id}:${prHeadSha}:notify_ready_for_human_review`,
        checkoutId: checkout.id,
        planVersionId: plan.id,
        deliveryUnitKey: unit.key,
        prHeadSha,
        title: "Ready for human review",
        message: `${checkout.name} is ready for human review`,
        automated: false,
      });
      continue;
    }
    if (gate?.status === "review_required" && gate.reasons.includes("review_pr_artifact_required") && prHeadSha) {
      if (managerRunning) {
        decisions.push({
          actionName: "run_review_pr",
          scopeKey: `checkout:${checkout.id}`,
          actionKey: "run_review_pr",
          factKey: `pr_head:${prHeadSha}`,
          idempotencyKey: `${checkout.id}:${plan.id}:${prHeadSha}:run_review_pr`,
          checkoutId: checkout.id,
          planVersionId: plan.id,
          deliveryUnitKey: unit.key,
          prHeadSha,
          title: "Run review",
          message: `Run review-pr for ${checkout.name} at ${prHeadSha}`,
          automated: true,
        });
      }
      continue;
    }
    if (managerRunning && shouldLaunchImplementation(checkout, gate, input.sessions)) {
      decisions.push({
        actionName: "launch_implementation",
        scopeKey: `checkout:${checkout.id}`,
        actionKey: "launch_implementation",
        factKey: `plan:${plan.id}:unit:${unit.key}`,
        idempotencyKey: `${input.workspaceId}:${plan.id}:${unit.key}:launch_implementation`,
        checkoutId: checkout.id,
        planVersionId: plan.id,
        deliveryUnitKey: unit.key,
        prHeadSha: null,
        title: "Launch implementation",
        message: `Launch implementation for ${checkout.name}`,
        automated: true,
      });
    }
  }
  return decisions;
}

function findDeliveryUnitCheckout(checkouts: WorktreeCheckout[], planVersionId: string, unitKey: string) {
  return (
    checkouts.find(
      (checkout) => checkout.deliveryPlanVersionId === planVersionId && checkout.deliveryUnitKey === unitKey,
    ) ?? null
  );
}

function blockingDependency(
  unit: WorkspacePlanDeliveryUnit,
  checkouts: WorktreeCheckout[],
  gatesByCheckout: Map<string, ManagerGateInput>,
): { fromUnitKey: string; type: WorkspacePlanDependencyEdgeType; message: string } | null {
  for (const dependency of unit.dependencies) {
    if (dependency.type === "parallel") continue;
    if (dependency.type === "manual") {
      return {
        fromUnitKey: dependency.fromUnitKey,
        type: dependency.type,
        message: `Delivery unit ${unit.key} is waiting on manual dependency ${dependency.fromUnitKey}`,
      };
    }
    const parent = checkouts.find((checkout) => checkout.deliveryUnitKey === dependency.fromUnitKey);
    const parentGate = parent ? gatesByCheckout.get(parent.id) : null;
    if (dependency.type === "stacked_on_pr" && parentGate?.status !== "ready_for_human_review") {
      return {
        fromUnitKey: dependency.fromUnitKey,
        type: dependency.type,
        message: `Delivery unit ${unit.key} is waiting for ${dependency.fromUnitKey} review readiness`,
      };
    }
    if (dependency.type === "wait_for_merge_or_release") {
      return {
        fromUnitKey: dependency.fromUnitKey,
        type: dependency.type,
        message: `Delivery unit ${unit.key} is waiting for ${dependency.fromUnitKey} merge or release`,
      };
    }
  }
  return null;
}

function shouldLaunchImplementation(
  checkout: WorktreeCheckout,
  gate: ManagerGateInput | undefined,
  sessions: AgentSession[],
): boolean {
  if (sessions.some((session) => isActiveImplementationSession(session, checkout.id))) return false;
  return !gate || gate.status === "not_started" || gate.status === "waiting_for_pr";
}

function isActiveImplementationSession(session: AgentSession, checkoutId: string): boolean {
  return (
    session.checkoutId === checkoutId &&
    session.role === "implementation" &&
    !["stopped", "failed", "unknown"].includes(session.status)
  );
}

function humanInput(
  workspaceId: string,
  planVersionId: string | null,
  checkoutId: string | null,
  reasonKey: string,
  message: string,
  deliveryUnitKey: string | null = null,
): ManagerDecision {
  const scope = checkoutId ? `checkout:${checkoutId}` : `workspace:${workspaceId}`;
  const factKey = `${planVersionId ?? "no_plan"}:${reasonKey}`;
  return {
    actionName: "notify_human_input_needed",
    scopeKey: scope,
    actionKey: "notify_human_input_needed",
    factKey,
    idempotencyKey: `${scope}:${factKey}:notify_human_input_needed`,
    checkoutId,
    planVersionId,
    deliveryUnitKey,
    prHeadSha: null,
    title: "Human input needed",
    message,
    automated: false,
  };
}
