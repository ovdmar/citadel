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
      deployHookCommand: null,
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
      archivedAt: null,
    });

    expect(store.listRepos()).toHaveLength(1);
    expect(store.query("SELECT version FROM schema_migrations ORDER BY version")).toEqual([
      { version: 1 },
      { version: 2 },
      { version: 3 },
      { version: 4 },
      { version: 5 },
      { version: 6 },
    ]);
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
      deployHookCommand: null,
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
      kind: "worktree",
      prUrl: null,
      issueKey: "MS-123",
      issueTitle: "John's task",
      issueUrl: "https://jira.example.test/browse/MS-123",
      slackThreadUrl: "https://meshstudio.slack.com/archives/C123/p456",
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
      logs: [],
      retriable: false,
      retryInput: null,
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
      hookOutput: {
        links: [{ label: "Preview", url: "https://example.test/preview", kind: "preview" }],
        actions: [],
        metadata: {},
      },
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
      logs: [],
      retriable: false,
      retryInput: null,
      createdAt: "2026-05-17T00:03:00.000Z",
      updatedAt: "2026-05-17T00:05:00.000Z",
    });

    expect(store.listWorkspaces(repo.id)).toMatchObject([
      {
        id: "ws_test",
        name: "John's task",
        issueKey: "MS-123",
        issueUrl: "https://jira.example.test/browse/MS-123",
        slackThreadUrl: "https://meshstudio.slack.com/archives/C123/p456",
        pinned: true,
        lifecycle: "ready",
        dirty: true,
      },
    ]);
    expect(store.listSessions("ws_test")).toMatchObject([{ id: "sess_test", transport: "connected" }]);
    expect(store.listOperations()).toMatchObject([{ id: "op_test", status: "succeeded", progress: 100 }]);
    expect(store.listActivity("ws_test")).toMatchObject([
      { id: "evt_test", source: "system", hookOutput: { links: [{ label: "Preview" }] } },
    ]);

    store.archiveWorkspace("ws_test", "archived", true);

    expect(store.listWorkspaces(repo.id)).toEqual([]);
    expect(store.query("SELECT lifecycle, dirty, archived_at FROM workspaces")).toEqual([
      expect.objectContaining({ lifecycle: "archived", dirty: 1 }),
    ]);
  });

  it("archives repositories and hides their active workspaces", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-db-"));
    dirs.push(dir);
    const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
    store.migrate();
    const repo = {
      id: "repo_remove",
      name: "Repo",
      rootPath: path.join(dir, "repo"),
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(dir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: ["github-gh"],
      deployHookCommand: null,
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
      archivedAt: null,
    };
    store.insertRepo(repo);
    store.insertWorkspace({
      id: "ws_remove",
      repoId: repo.id,
      name: "Remove me",
      path: path.join(dir, "worktrees", "remove-me"),
      branch: "remove-me",
      baseBranch: "main",
      source: "scratch",
      kind: "worktree",
      prUrl: null,
      issueKey: null,
      issueTitle: null,
      issueUrl: null,
      slackThreadUrl: null,
      section: "backlog",
      pinned: false,
      lifecycle: "ready",
      dirty: false,
      createdAt: "2026-05-17T00:01:00.000Z",
      updatedAt: "2026-05-17T00:01:00.000Z",
      archivedAt: null,
    });

    store.archiveRepo(repo.id);

    expect(store.listRepos()).toEqual([]);
    expect(store.listWorkspaces(repo.id)).toEqual([]);
    expect(store.query("SELECT archived_at FROM repos WHERE id = 'repo_remove'")[0]).toEqual(
      expect.objectContaining({ archived_at: expect.any(String) }),
    );
    expect(store.query("SELECT lifecycle, archived_at FROM workspaces WHERE id = 'ws_remove'")[0]).toEqual(
      expect.objectContaining({ lifecycle: "archived", archived_at: expect.any(String) }),
    );
  });

  it("round-trips scheduled agents and writes the one-shot cron placeholder", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-db-"));
    dirs.push(dir);
    const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
    store.migrate();

    const baseRepo = {
      id: "repo_sched",
      name: "Sched repo",
      rootPath: path.join(dir, "repo"),
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(dir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
      archivedAt: null,
    };
    store.insertRepo(baseRepo);

    const recurring = {
      id: "sched_recur",
      name: "Recurring",
      description: null,
      scheduleType: "recurring" as const,
      cron: "0 9 * * *",
      runAt: null,
      repoId: "repo_sched",
      runtimeId: "shell",
      prompt: null,
      workspaceStrategy: "new" as const,
      workspaceName: "recur",
      baseBranch: null,
      runMode: "workspace" as const,
      backgroundCwd: null,
      overlapPolicy: "skip" as const,
      enabled: true,
      lastRunAt: null,
      lastRunStatus: "never" as const,
      lastRunMessage: null,
      lastWorkspaceId: null,
      lastSessionId: null,
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
    };
    store.insertScheduledAgent(recurring);
    expect(store.findScheduledAgent("sched_recur")).toMatchObject({
      scheduleType: "recurring",
      cron: "0 9 * * *",
      runAt: null,
    });

    const once = {
      ...recurring,
      id: "sched_once",
      scheduleType: "once" as const,
      cron: null,
      runAt: "2030-01-01T09:00:00.000Z",
      workspaceName: "once",
    };
    store.insertScheduledAgent(once);

    // Public API returns cron=null for one-shots.
    expect(store.findScheduledAgent("sched_once")).toMatchObject({
      scheduleType: "once",
      cron: null,
      runAt: "2030-01-01T09:00:00.000Z",
    });
    // Storage column holds the never-matching sentinel — must not be the
    // unsafe "0 0 31 2 0" form that would fire every Sunday in February.
    expect(store.query<{ cron: string }>("SELECT cron FROM scheduled_agents WHERE id = 'sched_once'")[0]?.cron).toBe(
      "0 0 31 2 *",
    );

    // Flipping a one-shot to recurring clears run_at and writes the new cron.
    store.updateScheduledAgent("sched_once", { scheduleType: "recurring", cron: "*/15 * * * *", runAt: null });
    expect(store.findScheduledAgent("sched_once")).toMatchObject({
      scheduleType: "recurring",
      cron: "*/15 * * * *",
      runAt: null,
    });

    // Flipping a recurring agent to one-shot writes the sentinel back at the
    // column level and surfaces cron=null again.
    store.updateScheduledAgent("sched_recur", {
      scheduleType: "once",
      cron: null,
      runAt: "2030-02-01T09:00:00.000Z",
    });
    expect(store.findScheduledAgent("sched_recur")).toMatchObject({ scheduleType: "once", cron: null });
    expect(store.query<{ cron: string }>("SELECT cron FROM scheduled_agents WHERE id = 'sched_recur'")[0]?.cron).toBe(
      "0 0 31 2 *",
    );

    // resetScheduledAgentRun blanks the run tracking without touching schedule.
    store.recordScheduledAgentRun("sched_once", {
      lastRunAt: "2026-05-17T01:00:00.000Z",
      lastRunStatus: "succeeded",
      lastRunMessage: "ok",
    });
    const reset = store.resetScheduledAgentRun("sched_once");
    expect(reset).toMatchObject({ lastRunStatus: "never", lastRunMessage: null, lastRunAt: null });
  });
});
