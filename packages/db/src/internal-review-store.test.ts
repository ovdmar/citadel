import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "./index.js";

const dirs: string[] = [];
const timestamp = "2026-06-04T00:00:00.000Z";

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-review-db-"));
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
    name: "Workspace",
    path: path.join(dir, "workspace"),
    rootPath: path.join(dir, "workspace"),
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
    id: "checkout_1",
    workspaceId: "ws_1",
    repoId: "repo_1",
    name: "api",
    path: path.join(dir, "workspace", "api"),
    branch: "feature/api",
    baseBranch: "main",
    issue: null,
    intendedPr: {
      provider: "github",
      number: 42,
      url: "https://github.com/owner/repo/pull/42",
      headSha: "head_sha",
      baseRef: "main",
      fetchedAt: timestamp,
      checksGreen: null,
      mergeStateStatus: null,
      hasConflicts: null,
    },
    stackParentCheckoutId: null,
    inferredPurpose: "implementation",
    gateStatus: "review_required",
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
  });
  return store;
}

function insertScope(
  store: SqliteStore,
  overrides: Partial<Parameters<SqliteStore["upsertInternalReviewScope"]>[0]> = {},
) {
  return store.upsertInternalReviewScope({
    id: "scope_1",
    workspaceId: "ws_1",
    checkoutId: "checkout_1",
    repoId: "repo_1",
    providerType: "github",
    providerRepositoryKey: "owner/repo",
    externalReviewId: "PR_kw",
    externalReviewNumber: 42,
    externalReviewUrl: "https://github.com/owner/repo/pull/42",
    baseRef: "main",
    headRef: "feature/api",
    headSha: "head_sha",
    providerState: "open",
    observedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  });
}

describe("internal review migration and store", () => {
  it("creates v20 tables and records the schema migration", () => {
    const store = freshStore();
    const db = (store as unknown as { database: DatabaseSync }).database;
    for (const table of [
      "internal_review_scopes",
      "internal_review_threads",
      "internal_review_thread_replies",
      "internal_review_viewed_files",
    ]) {
      const row = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table) as
        | { name: string }
        | undefined;
      expect(row?.name).toBe(table);
    }
    const migration = db.prepare("SELECT name FROM schema_migrations WHERE version = 20").get() as
      | { name: string }
      | undefined;
    expect(migration?.name).toBe("internal-review-threads");
  });

  it("round-trips scopes, threads, replies, viewed state, and open/current counts", () => {
    const store = freshStore();
    const scope = insertScope(store);
    const thread = store.createInternalReviewThread(
      {
        id: "thread_1",
        reviewScopeId: scope.id,
        kind: "internal",
        status: "open",
        anchorState: "current",
        anchorKind: "line",
        bucket: "against-base",
        path: "src/app.ts",
        oldPath: null,
        side: "new",
        startLine: 10,
        endLine: 12,
        diffIdentity: "against-base:src/app.ts:head_sha",
        selectedText: "const value = 1;",
        authorKind: "user",
        authorLabel: "You",
        providerThreadId: null,
        resolvedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "reply_1",
        threadId: "thread_1",
        body: "Please simplify this.",
        authorKind: "user",
        authorLabel: "You",
        providerCommentId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    );

    expect(thread.replies).toHaveLength(1);
    expect(store.listInternalReviewThreads(scope.id)).toHaveLength(1);
    expect(store.countOpenCurrentInternalReviewThreads(scope.id)).toBe(1);

    store.addInternalReviewThreadReply({
      id: "reply_2",
      threadId: "thread_1",
      body: "Fixed this.",
      authorKind: "agent",
      authorLabel: "Agent",
      providerCommentId: null,
      createdAt: "2026-06-04T00:01:00.000Z",
      updatedAt: "2026-06-04T00:01:00.000Z",
    });
    expect(store.findInternalReviewThread("thread_1")?.replies.map((reply) => reply.body)).toEqual([
      "Please simplify this.",
      "Fixed this.",
    ]);

    expect(store.setInternalReviewThreadStatus("thread_1", "resolved", timestamp)?.status).toBe("resolved");
    expect(store.listInternalReviewThreads(scope.id)).toHaveLength(0);
    expect(store.listInternalReviewThreads(scope.id, { includeResolved: true })).toHaveLength(1);
    expect(store.setInternalReviewThreadStatus("thread_1", "open")?.resolvedAt).toBeNull();
    expect(store.setInternalReviewThreadAnchorState("thread_1", "outdated")?.anchorState).toBe("outdated");
    expect(store.listInternalReviewThreads(scope.id)).toHaveLength(0);
    expect(store.listInternalReviewThreads(scope.id, { includeOutdated: true })).toHaveLength(1);
    expect(store.countOpenCurrentInternalReviewThreads(scope.id)).toBe(0);

    const viewed = {
      reviewScopeId: scope.id,
      fileId: "against-base:src/app.ts",
      bucket: "against-base" as const,
      path: "src/app.ts",
      oldPath: null,
      diffIdentity: "against-base:src/app.ts:head_sha",
      viewed: true,
    };
    store.markInternalReviewFileViewed(viewed, timestamp);
    store.markInternalReviewFileViewed({ ...viewed, viewed: false }, "2026-06-04T00:02:00.000Z");
    const db = (store as unknown as { database: DatabaseSync }).database;
    const rows = db.prepare("SELECT viewed FROM internal_review_viewed_files").all() as Array<{ viewed: number }>;
    expect(rows).toEqual([{ viewed: 0 }]);
  });

  it("prunes only freshly observed terminal scopes and cascades review rows", () => {
    const store = freshStore();
    insertScope(store, { id: "scope_merged", providerState: "merged", observedAt: timestamp });
    insertScope(store, {
      id: "scope_stale_merged",
      providerState: "merged",
      observedAt: null,
      externalReviewId: "PR_stale",
      externalReviewNumber: 45,
    });
    insertScope(store, {
      id: "scope_closed_old",
      providerState: "closed",
      observedAt: "2026-05-01T00:00:00.000Z",
      externalReviewId: "PR_closed",
      externalReviewNumber: 43,
    });
    insertScope(store, {
      id: "scope_closed_recent",
      providerState: "closed",
      observedAt: "2026-06-03T00:00:00.000Z",
      externalReviewId: "PR_recent",
      externalReviewNumber: 44,
    });
    store.createInternalReviewThread(
      {
        id: "thread_merged",
        reviewScopeId: "scope_merged",
        kind: "internal",
        status: "open",
        anchorState: "current",
        anchorKind: "file",
        bucket: "against-base",
        path: "README.md",
        oldPath: null,
        side: null,
        startLine: null,
        endLine: null,
        diffIdentity: "identity",
        selectedText: null,
        authorKind: "user",
        authorLabel: null,
        providerThreadId: null,
        resolvedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "reply_merged",
        threadId: "thread_merged",
        body: "delete me",
        authorKind: "user",
        authorLabel: null,
        providerCommentId: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    );

    expect(store.pruneMergedInternalReviewScopes()).toBe(1);
    expect(store.findInternalReviewScope("scope_merged")).toBeNull();
    expect(store.findInternalReviewThread("thread_merged")).toBeNull();
    expect(store.findInternalReviewScope("scope_stale_merged")).not.toBeNull();

    expect(store.pruneClosedInternalReviewScopes("2026-05-15T00:00:00.000Z")).toBe(1);
    expect(store.findInternalReviewScope("scope_closed_old")).toBeNull();
    expect(store.findInternalReviewScope("scope_closed_recent")).not.toBeNull();
  });
});
