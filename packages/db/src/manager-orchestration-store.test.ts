import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderFactIdentity } from "@citadel/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "./index.js";

const dirs: string[] = [];
const timestamp = "2026-06-01T00:00:00.000Z";

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-manager-store-"));
  dirs.push(dir);
  const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
  store.migrate();
  store.insertRepo({
    id: "repo_1",
    name: "Repo",
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
    id: "ws_1",
    repoId: null,
    name: "Structured",
    path: path.join(dir, "workspace"),
    rootPath: path.join(dir, "workspace"),
    mode: "structured",
    branch: "home",
    baseBranch: "main",
    source: "scratch",
    kind: "root",
    lifecyclePhase: "implementation",
    parentIssue: { provider: "jira", key: "CIT-1", url: null, title: "Feature", status: "To Do", fetchedAt: null },
    prUrl: null,
    issueKey: null,
    issueTitle: null,
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
    id: "co_1",
    workspaceId: "ws_1",
    repoId: "repo_1",
    name: "api",
    path: path.join(dir, "workspace", "api"),
    branch: "feature/api",
    baseBranch: "main",
    issue: null,
    intendedPr: null,
    stackParentCheckoutId: null,
    inferredPurpose: "implementation",
    gateStatus: "not_started",
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
  });
  store.insertWorkspacePlanVersion({
    id: "plan_1",
    workspaceId: "ws_1",
    version: 1,
    status: "approved",
    path: "/tmp/plan.md",
    hash: "hash1",
    active: true,
    approvalMode: "manual",
    createdBySessionId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  store.insertWorkspaceManager({
    id: "mgr_1",
    workspaceId: "ws_1",
    pauseState: "running",
    heartbeatIntervalSeconds: 300,
    lastHeartbeatAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  return store;
}

describe("manager orchestration store methods", () => {
  it("round-trips parsed delivery units and checkout delivery-unit binding", () => {
    const store = setup();
    store.insertWorkspacePlanDeliveryUnits([
      {
        id: "unit_api",
        workspaceId: "ws_1",
        planVersionId: "plan_1",
        key: "api",
        repoId: "repo_1",
        repoName: "Repo",
        providerRepoUrl: null,
        checkoutName: "api",
        branch: "feature/api",
        baseBranch: "main",
        childIssue: { provider: "jira", key: "CIT-2", url: null, title: "API", status: null, fetchedAt: null },
        dependencies: [],
        status: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "unit_web",
        workspaceId: "ws_1",
        planVersionId: "plan_1",
        key: "web",
        repoId: "repo_1",
        repoName: "Repo",
        providerRepoUrl: null,
        checkoutName: "web",
        branch: "feature/web",
        baseBranch: "main",
        childIssue: { provider: "jira", key: "CIT-3", url: null, title: "Web", status: null, fetchedAt: null },
        dependencies: [],
        status: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]);
    store.insertWorkspacePlanDependencyEdges([
      {
        id: "edge_api_web",
        workspaceId: "ws_1",
        planVersionId: "plan_1",
        fromUnitKey: "api",
        toUnitKey: "web",
        type: "stacked_on_pr",
        reason: "web builds on api",
        createdAt: timestamp,
      },
    ]);

    expect(store.listWorkspacePlanDeliveryUnits("plan_1")).toMatchObject([
      { key: "api", dependencies: [] },
      { key: "web", dependencies: [{ fromUnitKey: "api", type: "stacked_on_pr" }] },
    ]);
    expect(
      store.updateWorkspaceCheckoutDeliveryUnit("co_1", { deliveryUnitKey: "api", deliveryPlanVersionId: "plan_1" }),
    ).toMatchObject({ deliveryUnitKey: "api", deliveryPlanVersionId: "plan_1" });
  });

  it("claims manager actions idempotently and fences lease updates by owner/generation", () => {
    const store = setup();
    const action = store.claimManagerAction({
      id: "act_1",
      workspaceId: "ws_1",
      checkoutId: "co_1",
      managerId: "mgr_1",
      actionName: "launch_implementation",
      status: "claimed",
      scopeKey: "ws_1:plan_1:api",
      actionKey: "launch_implementation",
      factKey: null,
      idempotencyKey: "ws_1:plan_1:api:launch",
      leaseOwnerId: "owner-a",
      leaseGeneration: 1,
      leaseExpiresAt: "2026-06-01T00:05:00.000Z",
      attemptCount: 0,
      maxAttempts: 3,
      operationId: null,
      sessionId: null,
      artifactId: null,
      prHeadSha: null,
      planVersionId: "plan_1",
      claimedAt: timestamp,
      completedAt: null,
      lastReconciledAt: null,
      error: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const duplicate = store.claimManagerAction({ ...action, id: "act_dup", leaseOwnerId: "owner-b" });
    expect(duplicate.id).toBe("act_1");

    expect(
      store.renewManagerActionLease("act_1", "owner-b", 1, {
        leaseOwnerId: "owner-b",
        leaseExpiresAt: "2026-06-01T00:10:00.000Z",
      }),
    ).toBeNull();
    const renewed = store.renewManagerActionLease("act_1", "owner-a", 1, {
      leaseOwnerId: "owner-b",
      leaseExpiresAt: "2026-06-01T00:10:00.000Z",
    });
    expect(renewed).toMatchObject({ leaseOwnerId: "owner-b", leaseGeneration: 2, attemptCount: 1 });
    expect(store.completeManagerAction("act_1", "owner-a", 1, { status: "succeeded" })).toBeNull();
    expect(
      store.completeManagerAction("act_1", "owner-b", 2, { status: "succeeded", sessionId: "sess_1" }),
    ).toMatchObject({ status: "succeeded", leaseOwnerId: null, sessionId: "sess_1" });
  });

  it("invalidates stale review artifacts and preserves current-head artifacts", () => {
    const store = setup();
    const reviews: Array<[string, string]> = [
      ["review_old", "oldsha"],
      ["review_new", "newsha"],
    ];
    for (const [id, headSha] of reviews) {
      store.insertReviewArtifact({
        id,
        workspaceId: "ws_1",
        checkoutId: "co_1",
        planVersionId: "plan_1",
        prProvider: "github",
        prNumber: 12,
        prUrl: "https://example.test/pr/12",
        headSha,
        result: "approve",
        findingsStatus: "none",
        blockingFindings: [],
        artifactPath: null,
        createdAt: timestamp,
      });
    }
    expect(store.invalidateCheckoutReviewArtifacts("co_1", "head_changed", "newsha")).toBe(1);
    expect(store.listCheckoutReviewArtifacts("co_1", { includeInvalidated: true })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "review_old", invalidatedReason: "head_changed" }),
        expect.objectContaining({ id: "review_new", invalidatedAt: null }),
      ]),
    );
    expect(store.listCheckoutReviewArtifacts("co_1")).toMatchObject([{ id: "review_new" }]);
  });

  it("keeps durable issue, transition, PR, and check facts distinct by provider/repo identity", () => {
    const store = setup();
    const issueIdentity = (providerInstanceId: string): ProviderFactIdentity => ({
      providerType: "jira",
      providerInstanceId,
      accountId: "acct",
      hostUrl: "https://jira.example.test",
      externalUrl: "https://jira.example.test/browse/CIT-2",
      workspaceBindingId: "binding_1",
      sourceBindingType: "checkout_child_issue",
      sourceBindingId: "co_1",
    });
    for (const providerInstanceId of ["jira-a", "jira-b"]) {
      store.upsertProviderIssueFact({
        id: `issue_${providerInstanceId}`,
        workspaceId: "ws_1",
        checkoutId: "co_1",
        deliveryUnitKey: "api",
        identity: issueIdentity(providerInstanceId),
        issueId: null,
        issueKey: "CIT-2",
        title: "API",
        status: "To Do",
        acceptanceSnapshot: null,
        fetchedAt: timestamp,
        staleAt: null,
        degradedReason: null,
        cooldownUntil: null,
      });
    }
    expect(
      store
        .listProviderIssueFacts("ws_1")
        .map((fact) => fact.identity.providerInstanceId)
        .sort(),
    ).toEqual(["jira-a", "jira-b"]);

    store.insertIssueTransitionAttempt({
      id: "transition_1",
      workspaceId: "ws_1",
      checkoutId: "co_1",
      managerActionId: null,
      identity: issueIdentity("jira-a"),
      issueId: null,
      issueKey: "CIT-2",
      requestedInternalState: "in_review",
      currentExternalStatus: "To Do",
      selectedTransition: null,
      resultingExternalStatus: null,
      success: false,
      degradedReason: "transition_unavailable",
      createdAt: timestamp,
    });
    expect(store.listIssueTransitionAttempts("ws_1")).toMatchObject([{ degradedReason: "transition_unavailable" }]);

    const prIdentity = {
      ...issueIdentity("github-a"),
      providerType: "github",
      sourceBindingType: "checkout_pr" as const,
      repositoryId: "repo_1",
      providerRepositoryKey: "org/repo",
    };
    store.upsertCheckoutPrFact({
      id: "pr_fact_1",
      workspaceId: "ws_1",
      checkoutId: "co_1",
      identity: prIdentity,
      prId: null,
      prNumber: 12,
      prUrl: "https://github.example.test/org/repo/pull/12",
      headSha: "abc",
      baseRef: "main",
      mergeStateStatus: "CLEAN",
      hasConflicts: false,
      fetchedAt: timestamp,
      staleAt: null,
      degradedReason: null,
      cooldownUntil: null,
    });
    store.upsertCheckoutCheckFacts([
      {
        id: "check_1",
        workspaceId: "ws_1",
        checkoutId: "co_1",
        prFactId: "pr_fact_1",
        identity: prIdentity,
        headSha: "abc",
        checkId: "ci-1",
        name: "ci",
        status: "completed",
        conclusion: "success",
        detailsUrl: null,
        startedAt: null,
        completedAt: null,
        fetchedAt: timestamp,
        staleAt: null,
        degradedReason: null,
      },
    ]);
    expect(store.listCheckoutPrFacts("co_1")).toMatchObject([{ prNumber: 12, hasConflicts: false }]);
    expect(store.listCheckoutCheckFacts("co_1")).toMatchObject([{ name: "ci", conclusion: "success" }]);
  });

  it("validates, revokes, and lists agent tool authorities plus local notifications", () => {
    const store = setup();
    store.insertWorkspaceSession({
      id: "sess_1",
      workspaceId: "ws_1",
      kind: "agent",
      runtimeId: "codex",
      displayName: "Implementation",
      status: "running",
      transport: "connected",
      tmuxSessionName: "tmux",
      tmuxSessionId: "$1",
      targetType: "worktree_checkout",
      checkoutId: "co_1",
      managerActionId: "act_1",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    store.mintAgentToolAuthority({
      id: "auth_1",
      tokenHash: "x".repeat(64),
      sessionId: "sess_1",
      role: "implementation",
      actionId: "implementation.review_pr",
      checkoutId: "co_1",
      planVersionId: "plan_1",
      managerActionId: null,
      allowedToolNames: ["register_checkout_review_artifact"],
      issuedAt: timestamp,
      expiresAt: "2026-06-01T00:10:00.000Z",
      revokedAt: null,
      revocationReason: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(store.validateAgentToolAuthority("x".repeat(64), "2026-06-01T00:05:00.000Z")?.sessionId).toBe("sess_1");
    expect(store.validateAgentToolAuthority("x".repeat(64), "2026-06-01T00:11:00.000Z")).toBeNull();
    expect(store.revokeAuthoritiesForSession("sess_1", "2026-06-01T00:06:00.000Z", "session_closed")).toBe(1);
    expect(store.validateAgentToolAuthority("x".repeat(64), "2026-06-01T00:07:00.000Z")).toBeNull();
    expect(store.listAgentToolAuthorities("sess_1")).toMatchObject([{ revokedAt: "2026-06-01T00:06:00.000Z" }]);

    store.upsertLocalNotificationEvent({
      id: "note_1",
      workspaceId: "ws_1",
      checkoutId: "co_1",
      type: "human_input_needed",
      status: "active",
      title: "Input needed",
      message: "Plan needs delivery units",
      dedupeKey: "ws_1:plan_1:missing-units",
      triggeringFactFingerprint: "plan_1:missing-units",
      managerActionId: null,
      resolvedAt: null,
      rearmedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    expect(store.listLocalNotificationEvents("ws_1")).toMatchObject([{ type: "human_input_needed", status: "active" }]);
  });
});
