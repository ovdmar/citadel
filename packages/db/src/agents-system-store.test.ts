import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "./index.js";

const dirs: string[] = [];
const timestamp = "2026-06-01T00:00:00.000Z";

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-agents-db-"));
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
    path: path.join(dir, "structured"),
    rootPath: path.join(dir, "structured"),
    mode: "structured",
    branch: "home",
    baseBranch: "main",
    source: "scratch",
    kind: "root",
    lifecyclePhase: "discovery_inputs",
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
  return store;
}

describe("agents system store methods", () => {
  it("round-trips structured workspace metadata and checkouts", () => {
    const store = freshStore();
    expect(store.listWorkspaces()[0]).toMatchObject({
      id: "ws_1",
      repoId: null,
      rootPath: expect.stringContaining("structured"),
      mode: "structured",
      lifecyclePhase: "discovery_inputs",
      parentIssue: { provider: "jira", key: "CIT-1", status: "To Do" },
    });
    store.insertWorkspaceCheckout({
      id: "co_1",
      workspaceId: "ws_1",
      repoId: "repo_1",
      name: "api",
      path: "/tmp/api",
      branch: "feature/api",
      baseBranch: "main",
      issue: { provider: "jira", key: "CIT-2", url: null, title: null, status: null, fetchedAt: null },
      intendedPr: {
        provider: "github",
        number: 12,
        url: "https://example.test/pr/12",
        state: "open",
        headSha: "abc",
        baseRef: "main",
        fetchedAt: timestamp,
        checksGreen: true,
        mergeStateStatus: "CLEAN",
        hasConflicts: false,
      },
      stackParentCheckoutId: null,
      inferredPurpose: "implementation",
      gateStatus: "waiting_for_pr",
      createdAt: timestamp,
      updatedAt: timestamp,
      archivedAt: null,
    });

    expect(store.listWorkspaceCheckouts("ws_1")).toMatchObject([
      {
        id: "co_1",
        issue: { key: "CIT-2" },
        intendedPr: {
          number: 12,
          state: "open",
          fetchedAt: timestamp,
          checksGreen: true,
          mergeStateStatus: "CLEAN",
          hasConflicts: false,
        },
        gateStatus: "waiting_for_pr",
      },
    ]);
    expect(store.updateWorkspaceCheckoutGate("co_1", "ready_for_human_review")).toMatchObject({
      gateStatus: "ready_for_human_review",
    });
    expect(
      store.updateWorkspaceCheckoutIssue("co_1", {
        provider: "jira",
        key: "CIT-2",
        url: null,
        title: "API ticket",
        status: "In Review",
        fetchedAt: timestamp,
      }),
    ).toMatchObject({ issue: { title: "API ticket", status: "In Review", fetchedAt: timestamp } });
    expect(
      store.updateWorkspaceCheckoutPr("co_1", {
        provider: "github",
        number: 13,
        url: "https://example.test/pr/13",
        state: "open",
        headSha: "def",
        baseRef: "main",
        fetchedAt: timestamp,
        checksGreen: false,
        mergeStateStatus: "DIRTY",
        hasConflicts: true,
      }),
    ).toMatchObject({
      intendedPr: {
        number: 13,
        state: "open",
        headSha: "def",
        fetchedAt: timestamp,
        checksGreen: false,
        mergeStateStatus: "DIRTY",
        hasConflicts: true,
      },
    });
  });

  it("stores plans, manager state, deviations, events, and review artifacts", () => {
    const store = freshStore();
    store.insertWorkspaceCheckout({
      id: "co_1",
      workspaceId: "ws_1",
      repoId: "repo_1",
      name: "api",
      path: "/tmp/api",
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
    store.insertWorkspacePlanVersion({
      id: "plan_2",
      workspaceId: "ws_1",
      version: 2,
      status: "approved",
      path: "/tmp/plan2.md",
      hash: "hash2",
      active: true,
      approvalMode: "auto",
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
    store.insertManagerEvent({
      id: "evt_1",
      workspaceId: "ws_1",
      managerId: "mgr_1",
      type: "heartbeat",
      scopeKey: "workspace:ws_1",
      actionKey: "manager.heartbeat_digest",
      idempotencyKey: "heartbeat:1",
      status: "succeeded",
      message: "ok",
      createdAt: timestamp,
    });
    store.insertManagerEvent({
      id: "evt_duplicate",
      workspaceId: "ws_1",
      managerId: "mgr_1",
      type: "heartbeat",
      scopeKey: "workspace:ws_1",
      actionKey: "manager.heartbeat_digest",
      idempotencyKey: "heartbeat:1",
      status: "succeeded",
      message: "duplicate",
      createdAt: timestamp,
    });
    store.insertPlanDeviationReport({
      id: "dev_1",
      workspaceId: "ws_1",
      checkoutId: "co_1",
      planVersionId: "plan_2",
      severity: "blocking",
      description: "Need replan",
      status: "open",
      reportedBySessionId: null,
      createdAt: timestamp,
      resolvedAt: null,
    });
    store.insertReviewArtifact({
      id: "review_1",
      workspaceId: "ws_1",
      checkoutId: "co_1",
      planVersionId: "plan_2",
      prProvider: "github",
      prNumber: 12,
      prUrl: "https://example.test/pr/12",
      headSha: "abc",
      result: "request_changes",
      findingsStatus: "open_blocking",
      blockingFindings: ["fix tests"],
      artifactPath: "/tmp/review.md",
      createdAt: timestamp,
    });

    expect(store.findActiveWorkspacePlan("ws_1")).toMatchObject({ id: "plan_2", approvalMode: "auto" });
    expect(store.listWorkspacePlanVersions("ws_1").find((plan) => plan.id === "plan_1")?.active).toBe(false);
    expect(store.setWorkspaceManagerPause("ws_1", "paused")).toMatchObject({ pauseState: "paused" });
    expect(store.listManagerEvents("ws_1")).toHaveLength(1);
    expect(store.listPlanDeviationReports("ws_1")).toMatchObject([{ id: "dev_1", severity: "blocking" }]);
    expect(store.listReviewArtifacts("co_1")).toMatchObject([
      { id: "review_1", findingsStatus: "open_blocking", blockingFindings: ["fix tests"] },
    ]);
  });

  it("enforces structured workspace foreign keys and cascades workspace deletes", () => {
    const store = freshStore();
    expect(() =>
      store.insertWorkspaceCheckout({
        id: "co_orphan",
        workspaceId: "ws_missing",
        repoId: "repo_1",
        name: "api",
        path: "/tmp/orphan",
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
      }),
    ).toThrow();

    store.insertWorkspaceCheckout({
      id: "co_1",
      workspaceId: "ws_1",
      repoId: "repo_1",
      name: "api",
      path: "/tmp/api",
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
    store.insertManagerEvent({
      id: "evt_1",
      workspaceId: "ws_1",
      managerId: "mgr_1",
      type: "heartbeat",
      scopeKey: "workspace:ws_1",
      actionKey: "manager.heartbeat_digest",
      idempotencyKey: "heartbeat:cascade",
      status: "succeeded",
      message: "ok",
      createdAt: timestamp,
    });
    store.insertPlanDeviationReport({
      id: "dev_1",
      workspaceId: "ws_1",
      checkoutId: "co_1",
      planVersionId: "plan_1",
      severity: "blocking",
      description: "Need replan",
      status: "open",
      reportedBySessionId: null,
      createdAt: timestamp,
      resolvedAt: null,
    });
    store.insertReviewArtifact({
      id: "review_1",
      workspaceId: "ws_1",
      checkoutId: "co_1",
      planVersionId: "plan_1",
      prProvider: "github",
      prNumber: 12,
      prUrl: "https://example.test/pr/12",
      headSha: "abc",
      result: "approve",
      findingsStatus: "none",
      blockingFindings: [],
      artifactPath: "/tmp/review.md",
      createdAt: timestamp,
    });

    store.deleteWorkspace("ws_1");

    for (const table of [
      "workspace_checkouts",
      "workspace_plan_versions",
      "workspace_managers",
      "manager_events",
      "plan_deviation_reports",
      "checkout_review_artifacts",
    ]) {
      expect(store.query<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`)[0]?.count).toBe(0);
    }
  });
});
