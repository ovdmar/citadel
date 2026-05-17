import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteStore } from "./index.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("SqliteStore", () => {
  it("migrates and persists repo/workspace/session/activity records", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-db-"));
    dirs.push(dir);
    const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
    store.migrate();

    store.insertRepo({
      id: "repo_test",
      name: "Repo",
      rootPath: path.join(dir, "repo"),
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(dir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
      archivedAt: null,
    });

    expect(store.listRepos()).toHaveLength(1);
    expect(store.query("SELECT version FROM schema_migrations")).toEqual([{ version: 1 }]);
  });

  it("round-trips workspace, session, operation, and activity state", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-db-"));
    dirs.push(dir);
    const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
    store.migrate();
    const repo = {
      id: "repo_test",
      name: "Repo",
      rootPath: path.join(dir, "repo"),
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(dir, "worktrees"),
      setupHookIds: ["setup"],
      teardownHookIds: ["teardown"],
      providerIds: ["github-gh"],
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
      archivedAt: null,
    };
    store.insertRepo(repo);
    store.insertWorkspace({
      id: "ws_test",
      repoId: repo.id,
      name: "John's task",
      path: path.join(dir, "worktrees", "johns-task"),
      branch: "johns-task",
      baseBranch: "main",
      source: "issue",
      prUrl: null,
      issueKey: "MS-123",
      issueTitle: "John's task",
      section: "backlog",
      pinned: true,
      lifecycle: "creating",
      dirty: false,
      createdAt: "2026-05-17T00:01:00.000Z",
      updatedAt: "2026-05-17T00:01:00.000Z",
      archivedAt: null,
    });
    store.insertSession({
      id: "sess_test",
      workspaceId: "ws_test",
      runtimeId: "shell",
      displayName: "Shell",
      status: "running",
      transport: "connected",
      tmuxSessionName: "citadel_test",
      tmuxSessionId: "$1",
      createdAt: "2026-05-17T00:02:00.000Z",
      updatedAt: "2026-05-17T00:02:00.000Z",
    });
    store.upsertOperation({
      id: "op_test",
      type: "workspace.create",
      status: "running",
      repoId: repo.id,
      workspaceId: "ws_test",
      progress: 50,
      message: "Creating workspace",
      error: null,
      createdAt: "2026-05-17T00:03:00.000Z",
      updatedAt: "2026-05-17T00:03:00.000Z",
    });
    store.addActivity({
      id: "evt_test",
      type: "workspace.created",
      source: "system",
      repoId: repo.id,
      workspaceId: "ws_test",
      operationId: "op_test",
      message: "Created John's task",
      createdAt: "2026-05-17T00:04:00.000Z",
    });

    store.updateWorkspaceLifecycle("ws_test", "ready", true);
    store.upsertOperation({
      id: "op_test",
      type: "workspace.create",
      status: "succeeded",
      repoId: repo.id,
      workspaceId: "ws_test",
      progress: 100,
      message: "Workspace ready",
      error: null,
      createdAt: "2026-05-17T00:03:00.000Z",
      updatedAt: "2026-05-17T00:05:00.000Z",
    });

    expect(store.listWorkspaces(repo.id)).toMatchObject([
      {
        id: "ws_test",
        name: "John's task",
        issueKey: "MS-123",
        pinned: true,
        lifecycle: "ready",
        dirty: true,
      },
    ]);
    expect(store.listSessions("ws_test")).toMatchObject([{ id: "sess_test", transport: "connected" }]);
    expect(store.listOperations()).toMatchObject([{ id: "op_test", status: "succeeded", progress: 100 }]);
    expect(store.listActivity("ws_test")).toMatchObject([{ id: "evt_test", source: "system" }]);

    store.archiveWorkspace("ws_test", "archived", true);

    expect(store.listWorkspaces(repo.id)).toEqual([]);
    expect(store.query("SELECT lifecycle, dirty, archived_at FROM workspaces")).toEqual([
      expect.objectContaining({ lifecycle: "archived", dirty: 1 }),
    ]);
  });
});
