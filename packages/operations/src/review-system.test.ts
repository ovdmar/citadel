import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HookConfig } from "@citadel/config";
import type { Repo, Workspace } from "@citadel/contracts";
import { SqliteStore } from "@citadel/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addReviewComment,
  deleteReviewComment,
  listReviewComments,
  requestReviewForWorkspace,
  updateReviewComment,
} from "./review-system.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-review-ops-"));
  dirs.push(dir);
  const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
  store.migrate();
  return { dir, store };
}

function makeRepo(dir: string, opts: { requestReviewHookIds?: string[] | undefined } = {}): Repo {
  const now = new Date().toISOString();
  return {
    id: "repo_1",
    name: "Repo",
    rootPath: path.join(dir, "repo"),
    defaultBranch: "main",
    defaultRemote: "origin",
    worktreeParent: path.join(dir, "wt"),
    setupHookIds: [],
    teardownHookIds: [],
    requestReviewHookIds: opts.requestReviewHookIds ?? [],
    providerIds: [],
    deployHookCommand: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };
}

function makeWorkspace(dir: string): Workspace {
  const now = new Date().toISOString();
  return {
    id: "ws_1",
    repoId: "repo_1",
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
  };
}

function hookConfig(command: string, args: string[] = []): HookConfig {
  return {
    id: "rev",
    kind: "command" as const,
    event: "workspace.requestReview" as const,
    command,
    args,
    blocking: true,
  };
}

function seed(opts: { hooks?: HookConfig[]; requestReviewHookIds?: string[] } = {}) {
  const { dir, store } = makeStore();
  const repo = makeRepo(dir, { requestReviewHookIds: opts.requestReviewHookIds });
  const workspace = makeWorkspace(dir);
  fs.mkdirSync(workspace.path, { recursive: true });
  store.insertRepo(repo);
  store.insertWorkspace(workspace);
  const activity = vi.fn();
  const config = {
    hooks: opts.hooks ?? [],
    commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
  };
  return { dir, store, repo, workspace, activity, config };
}

describe("requestReviewForWorkspace", () => {
  it("returns no-hook when nothing configured", async () => {
    const f = seed();
    const result = await requestReviewForWorkspace({
      store: f.store,
      config: f.config,
      activity: f.activity,
      repo: f.repo,
      workspace: f.workspace,
      diff: { files: [], addedLines: 0, deletedLines: 0, truncated: false },
    });
    expect(result.kind).toBe("no-hook");
    expect(f.activity).not.toHaveBeenCalled();
    expect(f.store.latestReviewSuggestionRun(f.workspace.id)).toBeNull();
  });

  it("records succeeded run and exactly one activity row when the hook emits valid JSON", async () => {
    const hookOutput = JSON.stringify({
      suggestions: [{ id: "s1", kind: "reviewer", label: "@alice" }],
    });
    const f = seed({
      hooks: [hookConfig("node", ["-e", `process.stdout.write(${JSON.stringify(hookOutput)})`])],
      requestReviewHookIds: ["rev"],
    });
    const result = await requestReviewForWorkspace({
      store: f.store,
      config: f.config,
      activity: f.activity,
      repo: f.repo,
      workspace: f.workspace,
      diff: { files: [], addedLines: 0, deletedLines: 0, truncated: false },
    });
    expect(result.kind).toBe("succeeded");
    if (result.kind === "succeeded") {
      expect(result.output.suggestions[0]?.label).toBe("@alice");
      expect(result.run.status).toBe("succeeded");
    }
    expect(f.activity).toHaveBeenCalledTimes(1);
    expect(f.activity).toHaveBeenCalledWith(
      "hook.workspace.requestReview",
      "hook",
      expect.stringContaining("returned 1 suggestion"),
      f.repo.id,
      f.workspace.id,
      null,
    );
  });

  it("treats an empty-stdout success as zero suggestions and still records a succeeded run", async () => {
    const f = seed({
      hooks: [hookConfig("node", ["-e", "process.exit(0)"])],
      requestReviewHookIds: ["rev"],
    });
    const result = await requestReviewForWorkspace({
      store: f.store,
      config: f.config,
      activity: f.activity,
      repo: f.repo,
      workspace: f.workspace,
      diff: { files: [], addedLines: 0, deletedLines: 0, truncated: false },
    });
    expect(result.kind).toBe("succeeded");
    if (result.kind === "succeeded") {
      expect(result.output.suggestions).toEqual([]);
      expect(result.run.output?.suggestions).toEqual([]);
    }
  });

  it("records a failed run and a failed activity when the hook returns invalid JSON", async () => {
    const f = seed({
      hooks: [hookConfig("node", ["-e", "process.stdout.write('{nope')"])],
      requestReviewHookIds: ["rev"],
    });
    const result = await requestReviewForWorkspace({
      store: f.store,
      config: f.config,
      activity: f.activity,
      repo: f.repo,
      workspace: f.workspace,
      diff: { files: [], addedLines: 0, deletedLines: 0, truncated: false },
    });
    expect(result.kind).toBe("failed");
    expect(f.activity).toHaveBeenCalledTimes(1);
    expect(f.activity).toHaveBeenCalledWith(
      "hook.workspace.requestReview.failed",
      "hook",
      expect.stringContaining("invalid output"),
      f.repo.id,
      f.workspace.id,
      null,
    );
  });

  it("records a failed run when the hook exits non-zero", async () => {
    const f = seed({
      hooks: [hookConfig("node", ["-e", "process.stderr.write('nope'); process.exit(2)"])],
      requestReviewHookIds: ["rev"],
    });
    const result = await requestReviewForWorkspace({
      store: f.store,
      config: f.config,
      activity: f.activity,
      repo: f.repo,
      workspace: f.workspace,
      diff: { files: [], addedLines: 0, deletedLines: 0, truncated: false },
    });
    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.run.exitStatus).toBe(2);
      expect(result.run.stderr).toContain("nope");
    }
  });

  it("records a timed_out run when the hook exceeds the configured timeout", async () => {
    const f = seed({
      hooks: [hookConfig("node", ["-e", "setTimeout(() => {}, 5000)"])],
      requestReviewHookIds: ["rev"],
    });
    f.config.commandPolicy.hookTimeoutMs = 50;
    const result = await requestReviewForWorkspace({
      store: f.store,
      config: f.config,
      activity: f.activity,
      repo: f.repo,
      workspace: f.workspace,
      diff: { files: [], addedLines: 0, deletedLines: 0, truncated: false },
    });
    expect(result.kind).toBe("timed-out");
    if (result.kind === "timed-out") expect(result.run.status).toBe("timed_out");
    expect(f.activity).toHaveBeenCalledWith(
      "hook.workspace.requestReview.failed",
      "hook",
      expect.stringContaining("timed out"),
      f.repo.id,
      f.workspace.id,
      null,
    );
  });
});

describe("review comment service", () => {
  it("addReviewComment persists and logs activity exactly once", () => {
    const f = seed();
    const row = addReviewComment({
      store: f.store,
      activity: f.activity,
      workspaceId: f.workspace.id,
      body: "looks good",
      author: "operator",
      repoId: f.repo.id,
    });
    expect(row.author).toBe("operator");
    expect(f.activity).toHaveBeenCalledTimes(1);
    expect(f.activity).toHaveBeenCalledWith(
      "review.comment.added",
      "user",
      expect.stringContaining("added by operator"),
      f.repo.id,
      f.workspace.id,
      null,
    );
    expect(listReviewComments({ store: f.store, workspaceId: f.workspace.id })).toHaveLength(1);
  });

  it("updateReviewComment returns conflict on stale token and does not log activity", () => {
    const f = seed();
    const created = addReviewComment({
      store: f.store,
      activity: f.activity,
      workspaceId: f.workspace.id,
      body: "v1",
      author: "operator",
      repoId: f.repo.id,
    });
    f.activity.mockClear();
    const result = updateReviewComment({
      store: f.store,
      activity: f.activity,
      id: created.id,
      body: "v2",
      ifUpdatedAtMatches: "1970-01-01T00:00:00.000Z",
      repoId: f.repo.id,
    });
    expect(result.kind).toBe("conflict");
    expect(f.activity).not.toHaveBeenCalled();
  });

  it("updateReviewComment with status=resolved logs review.comment.resolved", () => {
    const f = seed();
    const created = addReviewComment({
      store: f.store,
      activity: f.activity,
      workspaceId: f.workspace.id,
      body: "v1",
      author: "operator",
      repoId: f.repo.id,
    });
    f.activity.mockClear();
    const result = updateReviewComment({
      store: f.store,
      activity: f.activity,
      id: created.id,
      status: "resolved",
      ifUpdatedAtMatches: created.updatedAt,
      repoId: f.repo.id,
    });
    expect(result.kind).toBe("updated");
    expect(f.activity).toHaveBeenCalledWith(
      "review.comment.resolved",
      "user",
      expect.stringContaining("resolved"),
      f.repo.id,
      f.workspace.id,
      null,
    );
  });

  it("deleteReviewComment soft-deletes and logs once", () => {
    const f = seed();
    const created = addReviewComment({
      store: f.store,
      activity: f.activity,
      workspaceId: f.workspace.id,
      body: "v1",
      author: "operator",
      repoId: f.repo.id,
    });
    f.activity.mockClear();
    const result = deleteReviewComment({
      store: f.store,
      activity: f.activity,
      id: created.id,
      ifUpdatedAtMatches: created.updatedAt,
      repoId: f.repo.id,
    });
    expect(result.kind).toBe("updated");
    expect(listReviewComments({ store: f.store, workspaceId: f.workspace.id })).toHaveLength(0);
    expect(f.activity).toHaveBeenCalledWith(
      "review.comment.deleted",
      "user",
      expect.stringContaining("deleted"),
      f.repo.id,
      f.workspace.id,
      null,
    );
  });
});
