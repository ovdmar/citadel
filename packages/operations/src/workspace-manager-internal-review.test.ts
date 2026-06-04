import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "@citadel/db";
import { afterEach, describe, expect, it } from "vitest";
import { getCheckoutGateStatus } from "./workspace-manager.js";

const dirs: string[] = [];
const timestamp = "2026-06-01T00:00:00.000Z";

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("workspace manager internal review gate", () => {
  it("blocks human-review readiness while current internal review threads are open", () => {
    const store = setupStore();
    insertOpenInternalReviewThread(store);

    expect(getCheckoutGateStatus({ store }, { checkoutId: "co_api" })).toMatchObject({
      ok: true,
      status: "review_blocked",
      reasons: ["open_internal_review_threads:1"],
    });

    store.setInternalReviewThreadStatus("thread_api", "resolved", "2026-06-01T00:01:00.000Z");
    expect(getCheckoutGateStatus({ store }, { checkoutId: "co_api" })).toMatchObject({
      ok: true,
      status: "ready_for_human_review",
      reasons: ["ready"],
    });
  });
});

function setupStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-internal-review-gate-"));
  dirs.push(dir);
  const rootPath = path.join(dir, "feature");
  fs.mkdirSync(path.join(rootPath, "api"), { recursive: true });
  const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
  store.migrate();
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
    repoId: "repo_api",
    name: "Manager Workspace",
    path: rootPath,
    rootPath,
    mode: "structured",
    branch: "home",
    baseBranch: "main",
    source: "scratch",
    kind: "root",
    lifecyclePhase: "implementation",
    parentIssue: null,
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
    id: "co_api",
    workspaceId: "ws_manager",
    repoId: "repo_api",
    name: "api",
    path: path.join(rootPath, "api"),
    branch: "feature/api",
    baseBranch: "main",
    issue: null,
    intendedPr: {
      provider: "github",
      number: 42,
      url: "https://example.test/pull/42",
      headSha: "abc123",
      baseRef: "main",
      fetchedAt: new Date().toISOString(),
      checksGreen: true,
      mergeStateStatus: "CLEAN",
      hasConflicts: false,
    },
    stackParentCheckoutId: null,
    inferredPurpose: "implementation",
    gateStatus: "review_required",
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
  });
  store.insertWorkspacePlanVersion({
    id: "plan_api",
    workspaceId: "ws_manager",
    version: 1,
    status: "approved",
    path: path.join(rootPath, "plan.md"),
    hash: "hash",
    active: true,
    approvalMode: "manual",
    createdBySessionId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  store.insertReviewArtifact({
    id: "review_api",
    workspaceId: "ws_manager",
    checkoutId: "co_api",
    planVersionId: "plan_api",
    prProvider: "github",
    prNumber: 42,
    prUrl: "https://example.test/pull/42",
    headSha: "abc123",
    result: "approve",
    findingsStatus: "none",
    blockingFindings: [],
    artifactPath: null,
    invalidatedAt: null,
    invalidatedReason: null,
    humanWaivedAt: null,
    humanWaivedBy: null,
    humanWaiverReason: null,
    createdAt: timestamp,
  });
  return store;
}

function insertOpenInternalReviewThread(store: SqliteStore) {
  const scope = store.upsertInternalReviewScope({
    id: "scope_api",
    workspaceId: "ws_manager",
    checkoutId: "co_api",
    repoId: "repo_api",
    providerType: "github",
    providerRepositoryKey: "owner/repo",
    externalReviewId: null,
    externalReviewNumber: 42,
    externalReviewUrl: "https://example.test/pull/42",
    baseRef: "main",
    headRef: "feature/api",
    headSha: "abc123",
    providerState: "open",
    observedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  store.createInternalReviewThread(
    {
      id: "thread_api",
      reviewScopeId: scope.id,
      kind: "internal",
      status: "open",
      anchorState: "current",
      anchorKind: "file",
      bucket: "against-base",
      path: "src/api.ts",
      oldPath: null,
      side: null,
      startLine: null,
      endLine: null,
      diffIdentity: "diff_identity",
      selectedText: null,
      authorKind: "user",
      authorLabel: null,
      providerThreadId: null,
      resolvedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: "reply_api",
      threadId: "thread_api",
      body: "Please address this before human review.",
      authorKind: "user",
      authorLabel: null,
      providerCommentId: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  );
}
