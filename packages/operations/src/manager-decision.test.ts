import type {
  AgentSession,
  WorkspaceManager,
  WorkspacePlanDeliveryUnit,
  WorkspacePlanVersion,
  WorktreeCheckout,
} from "@citadel/contracts";
import { describe, expect, it } from "vitest";
import { evaluateManagerDecisions } from "./manager-decision.js";

const timestamp = "2026-06-01T00:00:00.000Z";

function manager(overrides: Partial<WorkspaceManager> = {}): WorkspaceManager {
  return {
    id: "mgr_1",
    workspaceId: "ws_1",
    pauseState: "running",
    heartbeatIntervalSeconds: 300,
    lastHeartbeatAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function plan(overrides: Partial<WorkspacePlanVersion> = {}): WorkspacePlanVersion {
  return {
    id: "plan_1",
    workspaceId: "ws_1",
    version: 1,
    status: "approved",
    path: "/tmp/plan.md",
    hash: "hash",
    active: true,
    approvalMode: "manual",
    createdBySessionId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function unit(overrides: Partial<WorkspacePlanDeliveryUnit> = {}): WorkspacePlanDeliveryUnit {
  return {
    id: "unit_api",
    workspaceId: "ws_1",
    planVersionId: "plan_1",
    key: "api",
    repoId: "repo_1",
    repoName: "API",
    providerRepoUrl: null,
    checkoutName: "api",
    branch: "feature/api",
    baseBranch: "main",
    childIssue: { provider: "jira", key: "CIT-2", url: null, title: "API", status: null, fetchedAt: null },
    dependencies: [],
    status: "pending",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function checkout(overrides: Partial<WorktreeCheckout> = {}): WorktreeCheckout {
  return {
    id: "co_api",
    workspaceId: "ws_1",
    repoId: "repo_1",
    name: "api",
    path: "/tmp/workspace/api",
    branch: "feature/api",
    baseBranch: "main",
    issue: { provider: "jira", key: "CIT-2", url: null, title: "API", status: null, fetchedAt: null },
    intendedPr: null,
    stackParentCheckoutId: null,
    inferredPurpose: "implementation",
    deliveryUnitKey: "api",
    deliveryPlanVersionId: "plan_1",
    gateStatus: "not_started",
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    ...overrides,
  };
}

describe("manager decision reducer", () => {
  it("asks for human input when an approved plan or delivery-unit snapshot is missing", () => {
    expect(
      evaluateManagerDecisions({
        workspaceId: "ws_1",
        manager: manager(),
        activePlan: null,
        deliveryUnits: [],
        checkouts: [],
        sessions: [],
        gates: [],
      }),
    ).toMatchObject([{ actionName: "notify_human_input_needed", factKey: "no_plan:active_plan_required" }]);

    expect(
      evaluateManagerDecisions({
        workspaceId: "ws_1",
        manager: manager(),
        activePlan: plan(),
        deliveryUnits: [],
        checkouts: [],
        sessions: [],
        gates: [],
      }),
    ).toMatchObject([{ actionName: "notify_human_input_needed", factKey: "plan_1:plan_delivery_units_required" }]);
  });

  it("plans checkout creation, implementation launch, and review actions idempotently by fact key", () => {
    expect(
      evaluateManagerDecisions({
        workspaceId: "ws_1",
        manager: manager(),
        activePlan: plan(),
        deliveryUnits: [unit()],
        checkouts: [],
        sessions: [],
        gates: [],
      }),
    ).toMatchObject([{ actionName: "create_checkout", idempotencyKey: "ws_1:plan_1:api:create_checkout" }]);

    expect(
      evaluateManagerDecisions({
        workspaceId: "ws_1",
        manager: manager(),
        activePlan: plan(),
        deliveryUnits: [unit()],
        checkouts: [checkout()],
        sessions: [],
        gates: [{ checkoutId: "co_api", status: "waiting_for_pr", reasons: ["pr_required"] }],
      }),
    ).toMatchObject([{ actionName: "launch_implementation", idempotencyKey: "ws_1:plan_1:api:launch_implementation" }]);

    expect(
      evaluateManagerDecisions({
        workspaceId: "ws_1",
        manager: manager(),
        activePlan: plan(),
        deliveryUnits: [unit()],
        checkouts: [
          checkout({
            intendedPr: {
              provider: "github",
              number: 1,
              url: null,
              fetchedAt: null,
              headSha: "abc",
              baseRef: "main",
              checksGreen: null,
              mergeStateStatus: null,
              hasConflicts: null,
            },
          }),
        ],
        sessions: [],
        gates: [{ checkoutId: "co_api", status: "review_required", reasons: ["review_pr_artifact_required"] }],
      }),
    ).toMatchObject([{ actionName: "run_review_pr", idempotencyKey: "co_api:plan_1:abc:run_review_pr" }]);
  });

  it("does not launch duplicate implementation sessions and blocks manual dependencies", () => {
    const activeSession = {
      id: "sess_1",
      workspaceId: "ws_1",
      role: "implementation",
      checkoutId: "co_api",
      status: "running",
    } as AgentSession;
    expect(
      evaluateManagerDecisions({
        workspaceId: "ws_1",
        manager: manager(),
        activePlan: plan(),
        deliveryUnits: [unit()],
        checkouts: [checkout()],
        sessions: [activeSession],
        gates: [{ checkoutId: "co_api", status: "waiting_for_pr", reasons: ["pr_required"] }],
      }),
    ).toEqual([]);

    expect(
      evaluateManagerDecisions({
        workspaceId: "ws_1",
        manager: manager(),
        activePlan: plan(),
        deliveryUnits: [unit({ dependencies: [{ fromUnitKey: "api", type: "manual", reason: null }] })],
        checkouts: [],
        sessions: [],
        gates: [],
      }),
    ).toMatchObject([{ actionName: "notify_human_input_needed" }]);
  });
});
