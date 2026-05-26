import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

type Fixture = { dir: string; store: SqliteStore; repoId: string; workspaceId: string };

function makeStore(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-review-db-"));
  dirs.push(dir);
  const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
  store.migrate();
  const now = new Date().toISOString();
  store.insertRepo({
    id: "repo_test",
    name: "Repo",
    rootPath: path.join(dir, "repo"),
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: path.join(dir, "wt"),
    setupHookIds: [],
    teardownHookIds: [],
    requestReviewHookIds: [],
    providerIds: [],
    deployHookCommand: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  store.insertWorkspace({
    id: "ws_test",
    repoId: "repo_test",
    name: "ws",
    path: path.join(dir, "wt", "ws"),
    branch: "feature",
    baseBranch: "main",
    source: "scratch",
    kind: "worktree",
    prUrl: null,
    issueKey: null,
    issueTitle: null,
    issueUrl: null,
    slackThreadUrl: null,
    section: "default",
    pinned: false,
    lifecycle: "ready",
    dirty: false,
    namespaceId: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  return { dir, store, repoId: "repo_test", workspaceId: "ws_test" };
}

describe("review_comments", () => {
  it("inserts and lists a comment with default options", () => {
    const f = makeStore();
    f.store.insertReviewComment({
      id: "rc_1",
      workspaceId: f.workspaceId,
      author: "operator",
      body: "first",
    });
    const list = f.store.listReviewComments(f.workspaceId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "rc_1", body: "first", status: "open", deletedAt: null });
  });

  it("preserves file:line anchors round-trip", () => {
    const f = makeStore();
    f.store.insertReviewComment({
      id: "rc_2",
      workspaceId: f.workspaceId,
      author: "operator",
      body: "anchor",
      filePath: "src/foo.ts",
      lineStart: 10,
      lineEnd: 12,
      side: "RIGHT",
    });
    const list = f.store.listReviewComments(f.workspaceId);
    expect(list[0]).toMatchObject({
      filePath: "src/foo.ts",
      lineStart: 10,
      lineEnd: 12,
      side: "RIGHT",
    });
  });

  it("filters by status", () => {
    const f = makeStore();
    f.store.insertReviewComment({
      id: "rc_open",
      workspaceId: f.workspaceId,
      author: "operator",
      body: "o",
    });
    f.store.insertReviewComment({
      id: "rc_resolved",
      workspaceId: f.workspaceId,
      author: "operator",
      body: "r",
      status: "resolved",
    });
    expect(f.store.listReviewComments(f.workspaceId, { status: "open" }).map((c) => c.id)).toEqual(["rc_open"]);
    expect(f.store.listReviewComments(f.workspaceId, { status: "resolved" }).map((c) => c.id)).toEqual(["rc_resolved"]);
    expect(f.store.listReviewComments(f.workspaceId, { status: "all" })).toHaveLength(2);
  });

  it("excludes archived-workspace comments by default; includeArchived opts back in", () => {
    const f = makeStore();
    f.store.insertReviewComment({
      id: "rc_a",
      workspaceId: f.workspaceId,
      author: "operator",
      body: "hi",
    });
    f.store.archiveWorkspace(f.workspaceId, "archived");
    expect(f.store.listReviewComments(f.workspaceId)).toEqual([]);
    expect(f.store.listReviewComments(f.workspaceId, { includeArchived: true })).toHaveLength(1);
  });

  it("update returns conflict when the if-match token is stale", () => {
    const f = makeStore();
    const created = f.store.insertReviewComment({
      id: "rc_u",
      workspaceId: f.workspaceId,
      author: "operator",
      body: "v1",
    });
    const result = f.store.updateReviewComment("rc_u", { body: "v2" }, "1970-01-01T00:00:00.000Z");
    expect(result.kind).toBe("conflict");
    if (result.kind === "conflict") expect(result.latest.id).toBe(created.id);
    expect(f.store.getReviewComment("rc_u")?.body).toBe("v1");
  });

  it("update succeeds with a fresh token and bumps updated_at", () => {
    const f = makeStore();
    const created = f.store.insertReviewComment({
      id: "rc_u2",
      workspaceId: f.workspaceId,
      author: "operator",
      body: "v1",
    });
    const result = f.store.updateReviewComment(
      "rc_u2",
      { body: "v2", status: "resolved" },
      created.updatedAt,
      "2099-01-01T00:00:00.000Z",
    );
    expect(result.kind).toBe("updated");
    if (result.kind === "updated") {
      expect(result.row.body).toBe("v2");
      expect(result.row.status).toBe("resolved");
      expect(result.row.updatedAt).toBe("2099-01-01T00:00:00.000Z");
    }
  });

  it("soft-delete hides the row from default list but the physical row remains", () => {
    const f = makeStore();
    const created = f.store.insertReviewComment({
      id: "rc_d",
      workspaceId: f.workspaceId,
      author: "operator",
      body: "byte",
    });
    f.store.softDeleteReviewComment("rc_d", created.updatedAt);
    expect(f.store.listReviewComments(f.workspaceId)).toHaveLength(0);
    expect(f.store.listReviewComments(f.workspaceId, { includeDeleted: true })).toHaveLength(1);
    const physical = f.store.query<{ id: string }>("SELECT id FROM review_comments WHERE id = 'rc_d'");
    expect(physical).toHaveLength(1);
  });

  it("cascades on hard workspace delete", () => {
    const f = makeStore();
    f.store.insertReviewComment({
      id: "rc_c",
      workspaceId: f.workspaceId,
      author: "operator",
      body: "x",
    });
    f.store.query(`DELETE FROM workspaces WHERE id = '${f.workspaceId}'`);
    const physical = f.store.query<{ id: string }>("SELECT id FROM review_comments");
    expect(physical).toEqual([]);
  });
});

describe("review_suggestion_runs", () => {
  it("stores a succeeded run with parsed output and latest returns it", () => {
    const f = makeStore();
    f.store.insertReviewSuggestionRun({
      id: "run_1",
      workspaceId: f.workspaceId,
      hookId: "hook_1",
      status: "succeeded",
      durationMs: 30,
      exitStatus: 0,
      output: {
        suggestions: [{ id: "s1", kind: "note", label: "ok", detail: null, url: null, metadata: {} }],
        generatedAt: null,
        metadata: {},
      },
      stderr: null,
      error: null,
    });
    const latest = f.store.latestReviewSuggestionRun(f.workspaceId);
    expect(latest?.status).toBe("succeeded");
    expect(latest?.output?.suggestions[0]?.id).toBe("s1");
  });

  it("stores a failed run with stderr + error, no output", () => {
    const f = makeStore();
    f.store.insertReviewSuggestionRun({
      id: "run_2",
      workspaceId: f.workspaceId,
      hookId: "hook_1",
      status: "failed",
      durationMs: 5,
      exitStatus: 1,
      output: null,
      stderr: "boom",
      error: "Hook exited with 1",
    });
    const latest = f.store.latestReviewSuggestionRun(f.workspaceId);
    expect(latest?.status).toBe("failed");
    expect(latest?.output).toBeNull();
    expect(latest?.stderr).toBe("boom");
    expect(latest?.error).toBe("Hook exited with 1");
  });

  it("orders newest first", () => {
    const f = makeStore();
    f.store.insertReviewSuggestionRun({
      id: "run_a",
      workspaceId: f.workspaceId,
      hookId: "hook_1",
      status: "succeeded",
      durationMs: 5,
      exitStatus: 0,
      output: { suggestions: [], generatedAt: null, metadata: {} },
      stderr: null,
      error: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    f.store.insertReviewSuggestionRun({
      id: "run_b",
      workspaceId: f.workspaceId,
      hookId: "hook_1",
      status: "succeeded",
      durationMs: 5,
      exitStatus: 0,
      output: { suggestions: [], generatedAt: null, metadata: {} },
      stderr: null,
      error: null,
      createdAt: "2026-02-01T00:00:00.000Z",
    });
    expect(f.store.latestReviewSuggestionRun(f.workspaceId)?.id).toBe("run_b");
  });
});

describe("schema_migrations", () => {
  it("includes the review-system row at version 8", () => {
    const f = makeStore();
    const rows = f.store.query<{ version: number; name: string }>(
      "SELECT version, name FROM schema_migrations WHERE version = 8",
    );
    expect(rows).toEqual([{ version: 8, name: "review-system" }]);
  });

  it("is idempotent — re-running migrate is a no-op", () => {
    const f = makeStore();
    f.store.migrate();
    const rows = f.store.query<{ version: number }>("SELECT version FROM schema_migrations ORDER BY version");
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
