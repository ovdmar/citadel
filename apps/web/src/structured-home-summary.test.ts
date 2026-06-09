import type {
  LocalNotificationEvent,
  ManagerActionLedgerEntry,
  Workspace,
  WorkspaceManager,
  WorkspacePlanDeliveryUnit,
  WorkspacePlanVersion,
  WorktreeCheckout,
} from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { structuredHomeSummaryModel } from "./structured-home-summary.js";

const timestamp = "2026-06-01T00:00:00.000Z";

describe("structuredHomeSummaryModel", () => {
  it("selects active plan data, checkout bindings, notifications, and recent actions for one workspace", () => {
    const workspace = { id: "ws_1", name: "Structured", mode: "structured" } as Workspace;
    const plans = [
      { id: "plan_old", workspaceId: "ws_1", version: 1, active: false, status: "superseded" },
      { id: "plan_1", workspaceId: "ws_1", version: 2, active: true, status: "approved", approvalMode: "manual" },
    ] as WorkspacePlanVersion[];
    const model = structuredHomeSummaryModel({
      workspace,
      plans,
      managers: [{ id: "mgr_1", workspaceId: "ws_1", pauseState: "running" } as WorkspaceManager],
      deliveryUnits: [
        { id: "unit_1", workspaceId: "ws_1", planVersionId: "plan_1", key: "api", checkoutName: "api" },
        { id: "unit_other", workspaceId: "ws_2", planVersionId: "plan_other", key: "web", checkoutName: "web" },
      ] as WorkspacePlanDeliveryUnit[],
      checkouts: [
        { id: "co_1", workspaceId: "ws_1", deliveryPlanVersionId: "plan_1", deliveryUnitKey: "api" },
        { id: "co_2", workspaceId: "ws_1", deliveryPlanVersionId: "plan_old", deliveryUnitKey: "old" },
      ] as WorktreeCheckout[],
      managerActions: [
        action("act_old", "ws_1", "queued", "2026-06-01T00:00:00.000Z"),
        action("act_new", "ws_1", "running", "2026-06-01T00:01:00.000Z"),
        action("act_other", "ws_2", "running", "2026-06-01T00:02:00.000Z"),
      ],
      localNotifications: [
        notification("note_1", "ws_1", "active"),
        notification("note_2", "ws_1", "resolved"),
        notification("note_3", "ws_2", "active"),
      ],
    });

    expect(model.activePlan?.id).toBe("plan_1");
    expect(model.deliveryUnits.map((unit) => unit.key)).toEqual(["api"]);
    expect(model.checkoutBindings).toBe(1);
    expect(model.activeNotifications.map((event) => event.id)).toEqual(["note_1"]);
    expect(model.recentActions.map((entry) => entry.id)).toEqual(["act_new", "act_old"]);
  });
});

function action(
  id: string,
  workspaceId: string,
  status: ManagerActionLedgerEntry["status"],
  updatedAt: string,
): ManagerActionLedgerEntry {
  return {
    id,
    workspaceId,
    checkoutId: null,
    managerId: "mgr_1",
    actionName: "run_review_pr",
    status,
    scopeKey: "workspace:ws_1",
    actionKey: "run_review_pr",
    factKey: null,
    idempotencyKey: id,
    leaseOwnerId: null,
    leaseGeneration: 0,
    leaseExpiresAt: null,
    attemptCount: 0,
    maxAttempts: 3,
    operationId: null,
    sessionId: null,
    artifactId: null,
    prHeadSha: null,
    planVersionId: "plan_1",
    claimedAt: null,
    completedAt: null,
    lastReconciledAt: null,
    error: null,
    createdAt: timestamp,
    updatedAt,
  };
}

function notification(
  id: string,
  workspaceId: string,
  status: LocalNotificationEvent["status"],
): LocalNotificationEvent {
  return {
    id,
    workspaceId,
    checkoutId: null,
    type: "human_input_needed",
    status,
    title: "Input needed",
    message: "Plan needs attention",
    dedupeKey: id,
    triggeringFactFingerprint: id,
    managerActionId: null,
    resolvedAt: null,
    rearmedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
