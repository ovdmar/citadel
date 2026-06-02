import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PullRequestBinding } from "@citadel/contracts";
import { SqliteStore } from "@citadel/db";
import { afterEach, describe, expect, it } from "vitest";
import { OperationService } from "./index.js";

const dirs: string[] = [];
const validPlan = `# Plan

## Delivery Units
API work.

\`\`\`json citadel.delivery_units.v1
{
  "deliveryUnits": [
    {
      "key": "api",
      "repoName": "API",
      "checkoutName": "api",
      "branch": "feature/api",
      "childIssue": { "provider": "jira", "key": "CIT-2" },
      "dependencies": []
    }
  ]
}
\`\`\`

## Dependencies / Timeline
None.

## Manager Handoff
Launch implementation.

## Plan Version Notes
Initial.
`;

function freshPr(overrides: Partial<PullRequestBinding> = {}): PullRequestBinding {
  return {
    provider: "github",
    number: 42,
    url: "https://example.test/pull/42",
    headSha: "abc123",
    baseRef: "main",
    fetchedAt: new Date().toISOString(),
    checksGreen: true,
    mergeStateStatus: "CLEAN",
    hasConflicts: false,
    ...overrides,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-manager-"));
  dirs.push(dir);
  const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
  store.migrate();
  const service = new OperationService(store);
  const rootPath = path.join(dir, "feature");
  fs.mkdirSync(path.join(rootPath, "api"), { recursive: true });
  const timestamp = "2026-06-01T00:00:00.000Z";
  store.insertRepo({
    id: "repo_api",
    name: "API",
    rootPath: path.join(dir, "repo"),
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: path.join(dir, "worktrees"),
    setupHookIds: [],
    teardownHookIds: [],
    providerIds: [],
    deployHookCommand: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
  });
  store.insertWorkspace({
    id: "ws_manager",
    repoId: null,
    name: "Manager Workspace",
    path: rootPath,
    rootPath,
    mode: "structured",
    branch: "home",
    baseBranch: "main",
    source: "scratch",
    kind: "root",
    lifecyclePhase: "implementation",
    parentIssue: { provider: "jira", key: "CIT-1", url: null, title: "Parent", status: "To Do", fetchedAt: null },
    prUrl: null,
    issueKey: "CIT-1",
    issueTitle: "Parent",
    issueUrl: null,
    slackThreadUrl: null,
    section: "backlog",
    pinned: false,
    lifecycle: "ready",
    dirty: false,
    namespaceId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
  });
  store.insertWorkspaceCheckout({
    id: "co_api",
    workspaceId: "ws_manager",
    repoId: "repo_api",
    name: "api",
    path: path.join(rootPath, "api"),
    branch: "feature/api",
    baseBranch: "main",
    issue: { provider: "jira", key: "CIT-2", url: null, title: "API", status: "To Do", fetchedAt: null },
    intendedPr: freshPr(),
    stackParentCheckoutId: null,
    inferredPurpose: "implementation",
    gateStatus: "not_started",
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
  });
  const planPath = path.join(rootPath, "plan.md");
  fs.writeFileSync(planPath, validPlan);
  service.registerWorkspacePlan({
    workspaceId: "ws_manager",
    path: planPath,
    status: "approved",
    approvalMode: "manual",
  });
  return { store, service };
}

describe("workspace manager operations", () => {
  it("starts, pauses, and resumes one durable manager per structured workspace", () => {
    const { store, service } = setup();

    const started = service.startWorkspaceManager({ workspaceId: "ws_manager" });
    expect(started).toMatchObject({ ok: true, created: true, manager: { pauseState: "running" } });
    if (!started.ok) throw new Error("manager did not start");
    const again = service.startWorkspaceManager({ workspaceId: "ws_manager" });
    expect(again).toMatchObject({ ok: true, created: false, manager: { id: started.manager.id } });
    expect(service.pauseWorkspaceManager({ workspaceId: "ws_manager" })).toMatchObject({
      ok: true,
      manager: { pauseState: "paused" },
    });
    expect(service.resumeWorkspaceManager({ workspaceId: "ws_manager" })).toMatchObject({
      ok: true,
      manager: { pauseState: "running" },
    });
    expect(store.listActivity().map((event) => event.type)).toContain("workspace.manager.paused");
  });

  it("binds parsed delivery units, syncs provider facts, and claims manager actions idempotently", () => {
    const { store, service } = setup();
    service.startWorkspaceManager({ workspaceId: "ws_manager" });
    const first = service.runWorkspaceManagerTick({ workspaceId: "ws_manager" });

    expect(first).toMatchObject({
      ok: true,
      boundCheckouts: 1,
      providerFacts: { issues: 3, prs: 1 },
      actions: [expect.objectContaining({ actionName: "run_review_pr" })],
    });
    expect(store.findWorkspaceCheckout("co_api")).toMatchObject({
      deliveryUnitKey: "api",
      deliveryPlanVersionId: expect.any(String),
    });
    expect(
      store
        .listProviderIssueFacts("ws_manager")
        .map((fact) => fact.issueKey)
        .sort(),
    ).toEqual(["CIT-1", "CIT-2", "CIT-2"]);
    expect(store.listCheckoutPrFacts("co_api")).toMatchObject([{ prNumber: 42, headSha: "abc123" }]);

    const second = service.runWorkspaceManagerTick({ workspaceId: "ws_manager" });
    expect(second).toMatchObject({ ok: true, boundCheckouts: 0 });
    expect(
      store.listManagerActions("ws_manager").filter((action) => action.actionName === "run_review_pr"),
    ).toHaveLength(1);
  });

  it("reclaims expired manager action leases without duplicating the side effect claim", () => {
    const { store, service } = setup();
    service.startWorkspaceManager({ workspaceId: "ws_manager" });
    const first = service.runWorkspaceManagerTick({
      workspaceId: "ws_manager",
      leaseOwnerId: "worker-a",
      leaseSeconds: -1,
    });
    expect(first).toMatchObject({
      ok: true,
      actions: [expect.objectContaining({ actionName: "run_review_pr", leaseOwnerId: "worker-a" })],
    });

    const second = service.runWorkspaceManagerTick({
      workspaceId: "ws_manager",
      leaseOwnerId: "worker-b",
      leaseSeconds: 60,
    });
    expect(second).toMatchObject({
      ok: true,
      actions: [expect.objectContaining({ actionName: "run_review_pr", leaseOwnerId: "worker-b" })],
    });
    expect(
      store.listManagerActions("ws_manager").filter((action) => action.actionName === "run_review_pr"),
    ).toMatchObject([{ leaseOwnerId: "worker-b", leaseGeneration: 2, attemptCount: 2 }]);
  });

  it("authorizes review artifacts from linked review sessions and rejects mismatches", () => {
    const { store, service } = setup();
    service.startWorkspaceManager({ workspaceId: "ws_manager" });
    const tick = service.runWorkspaceManagerTick({ workspaceId: "ws_manager" });
    if (!tick.ok) throw new Error("manager tick failed");
    const action = store.listManagerActions("ws_manager").find((entry) => entry.actionName === "run_review_pr");
    const plan = store.findActiveWorkspacePlan("ws_manager");
    if (!action || !plan) throw new Error("review action missing");
    store.insertWorkspaceSession({
      id: "sess_review",
      kind: "agent",
      workspaceId: "ws_manager",
      runtimeId: "codex",
      displayName: "Review",
      targetType: "worktree_checkout",
      checkoutId: "co_api",
      role: "implementation",
      actionId: "implementation.review_pr",
      managed: true,
      parentSessionId: null,
      planVersionId: plan.id,
      managerActionId: action.id,
      status: "running",
      transport: "connected",
      tmuxSessionName: "tmux",
      tmuxSessionId: "$1",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });

    expect(
      service.registerCheckoutReviewArtifact({
        checkoutId: "co_api",
        sessionId: "sess_review",
        managerActionId: action.id,
        result: "approve",
        findingsStatus: "none",
        blockingFindings: [],
        artifactPath: null,
      }),
    ).toMatchObject({ ok: true, artifact: { checkoutId: "co_api", planVersionId: plan.id } });

    store.insertWorkspaceSession({
      id: "sess_bad_review",
      kind: "agent",
      workspaceId: "ws_manager",
      runtimeId: "codex",
      displayName: "CI",
      targetType: "worktree_checkout",
      checkoutId: "co_api",
      role: "implementation",
      actionId: "implementation.fix_ci",
      managed: true,
      parentSessionId: null,
      planVersionId: plan.id,
      managerActionId: action.id,
      status: "running",
      transport: "connected",
      tmuxSessionName: "tmux",
      tmuxSessionId: "$2",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    });
    expect(
      service.registerCheckoutReviewArtifact({
        checkoutId: "co_api",
        sessionId: "sess_bad_review",
        managerActionId: action.id,
        result: "approve",
        findingsStatus: "none",
        blockingFindings: [],
        artifactPath: null,
      }),
    ).toMatchObject({ ok: false, error: "review_action_mismatch" });
  });

  it("invalidates stale review artifacts when the PR head changes", () => {
    const { store, service } = setup();
    expect(
      service.registerCheckoutReviewArtifact({
        checkoutId: "co_api",
        notes: "old review",
        result: "approve",
        findingsStatus: "none",
        blockingFindings: [],
        artifactPath: null,
      }),
    ).toMatchObject({ ok: true });

    expect(
      service.markCheckoutReadyForReview({
        checkoutId: "co_api",
        pr: freshPr({ headSha: "def456" }),
        notes: "new head",
      }),
    ).toMatchObject({ ok: true, gate: { ok: true, status: "review_required" } });

    expect(store.listCheckoutReviewArtifacts("co_api", { includeInvalidated: true })).toEqual(
      expect.arrayContaining([expect.objectContaining({ headSha: "abc123", invalidatedReason: "head_changed" })]),
    );
    expect(store.listCheckoutReviewArtifacts("co_api")).toEqual([]);
  });

  it("evaluates PR review gates and records idempotent ready notifications", () => {
    const { store, service } = setup();
    service.startWorkspaceManager({ workspaceId: "ws_manager" });

    expect(service.getCheckoutGateStatus({ checkoutId: "co_api" })).toMatchObject({
      ok: true,
      status: "review_required",
      reasons: ["review_pr_artifact_required"],
    });

    expect(
      service.markCheckoutReadyForReview({ checkoutId: "co_api", notes: "implementation complete" }),
    ).toMatchObject({
      ok: true,
      gate: { ok: true, status: "review_required" },
    });

    const marked = service.registerCheckoutReviewArtifact({
      checkoutId: "co_api",
      notes: "review-pr passed",
      result: "approve",
      findingsStatus: "none",
      blockingFindings: [],
      artifactPath: null,
    });
    expect(marked).toMatchObject({ ok: true, gate: { ok: true, status: "ready_for_human_review" } });
    expect(store.findWorkspaceCheckout("co_api")).toMatchObject({ gateStatus: "ready_for_human_review" });
    expect(store.listReviewArtifacts("co_api")).toHaveLength(1);
    expect(store.listManagerEvents("ws_manager")).toHaveLength(1);

    service.registerCheckoutReviewArtifact({
      checkoutId: "co_api",
      notes: "retry",
      result: "approve",
      findingsStatus: "none",
      blockingFindings: [],
      artifactPath: null,
    });
    expect(store.listReviewArtifacts("co_api")).toHaveLength(1);
    expect(store.listManagerEvents("ws_manager")).toHaveLength(1);
  });

  it("blocks readiness when provider facts, review result, deviations, or stack parents are not ready", () => {
    const { store, service } = setup();

    store.updateWorkspaceCheckoutPr("co_api", freshPr({ fetchedAt: "2020-01-01T00:00:00.000Z" }));
    expect(service.getCheckoutGateStatus({ checkoutId: "co_api" })).toMatchObject({
      ok: true,
      status: "stale_provider",
      reasons: ["stale_provider_facts"],
    });

    store.updateWorkspaceCheckoutPr("co_api", freshPr({ checksGreen: false }));
    expect(service.getCheckoutGateStatus({ checkoutId: "co_api" })).toMatchObject({
      ok: true,
      status: "checks_failing",
      reasons: ["checks_failing"],
    });

    store.updateWorkspaceCheckoutPr("co_api", freshPr({ hasConflicts: true }));
    expect(service.getCheckoutGateStatus({ checkoutId: "co_api" })).toMatchObject({
      ok: true,
      status: "conflicts",
      reasons: ["pr_conflicts"],
    });

    store.updateWorkspaceCheckoutPr("co_api", freshPr());
    expect(
      service.registerCheckoutReviewArtifact({
        checkoutId: "co_api",
        result: "request_changes",
        findingsStatus: "open_blocking",
        blockingFindings: ["Fix API"],
        artifactPath: null,
      }),
    ).toMatchObject({ ok: true, gate: { ok: true, status: "review_blocked" } });

    const plan = store.findActiveWorkspacePlan("ws_manager");
    if (!plan) throw new Error("plan missing");
    store.insertPlanDeviationReport({
      id: "dev_blocking",
      workspaceId: "ws_manager",
      checkoutId: "co_api",
      planVersionId: plan.id,
      severity: "blocking",
      description: "Scope changed",
      status: "open",
      reportedBySessionId: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });
    expect(service.getCheckoutGateStatus({ checkoutId: "co_api" })).toMatchObject({
      ok: true,
      status: "blocked",
      reasons: ["open_plan_deviation"],
    });
  });

  it("updates provider-neutral checkout ticket status locally", () => {
    const { store, service } = setup();

    expect(
      service.updateTicketStatus({
        workspaceId: "ws_manager",
        checkoutId: "co_api",
        issue: { provider: "jira", key: "CIT-2", url: null, title: "API", status: "To Do", fetchedAt: null },
        targetState: "in_review",
      }),
    ).toMatchObject({ ok: true, issue: { status: "in_review" }, externalUpdate: "not_configured" });
    expect(store.findWorkspaceCheckout("co_api")?.issue).toMatchObject({ key: "CIT-2", status: "in_review" });
  });

  it("does not update a checkout ticket through another workspace id", () => {
    const { store, service } = setup();

    expect(
      service.updateTicketStatus({
        workspaceId: "ws_other",
        checkoutId: "co_api",
        issue: { provider: "jira", key: "CIT-2", url: null, title: "API", status: "To Do", fetchedAt: null },
        targetState: "done",
      }),
    ).toMatchObject({ ok: false, error: "checkout_not_found" });
    expect(store.findWorkspaceCheckout("co_api")?.issue).toMatchObject({ key: "CIT-2", status: "To Do" });
  });
});
