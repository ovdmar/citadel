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
      { version: 7 },
      { version: 8 },
      { version: 9 },
      { version: 10 },
      { version: 11 },
      { version: 12 },
    ]);
  });

  it("round-trips agent_sessions.status_reason_at via updateSessionStatus", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-db-"));
    dirs.push(dir);
    const store = new SqliteStore(path.join(dir, "test.sqlite"));
    store.migrate();
    store.insertRepo({
      id: "repo_srr",
      name: "Repo",
      rootPath: dir,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: dir,
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      archivedAt: null,
    });
    store.insertWorkspace({
      id: "ws_srr",
      repoId: "repo_srr",
      name: "ws",
      path: dir,
      branch: "main",
      baseBranch: "main",
      source: "imported",
      kind: "root",
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
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
      archivedAt: null,
    });
    store.insertSession({
      id: "sess_srr",
      workspaceId: "ws_srr",
      runtimeId: "shell",
      displayName: "Shell",
      status: "running",
      statusReason: null,
      lastStatusAt: "2026-05-26T00:00:00.000Z",
      lastOutputAt: null,
      endedAt: null,
      exitCode: null,
      transport: "connected",
      tmuxSessionName: "citadel_srr",
      tmuxSessionId: "$1",
      createdAt: "2026-05-26T00:00:00.000Z",
      updatedAt: "2026-05-26T00:00:00.000Z",
    });
    // Newly-created rows: statusReasonAt is null.
    expect(store.listSessions().find((s) => s.id === "sess_srr")?.statusReasonAt).toBeNull();

    // updateSessionStatus accepts statusReasonAt as a partial update.
    const reasonAt = "2026-05-26T01:00:00.000Z";
    store.updateSessionStatus("sess_srr", {
      status: "idle",
      statusReason: "idle_after_unexpected_exit",
      statusReasonAt: reasonAt,
    });
    expect(store.listSessions().find((s) => s.id === "sess_srr")?.statusReasonAt).toBe(reasonAt);

    // Setting statusReasonAt to null clears it (auto-clear path).
    store.updateSessionStatus("sess_srr", { statusReason: null, statusReasonAt: null });
    expect(store.listSessions().find((s) => s.id === "sess_srr")?.statusReasonAt).toBeNull();
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
      namespaceId: null,
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
      statusReason: null,
      lastStatusAt: "2026-05-17T00:02:00.000Z",
      lastOutputAt: null,
      endedAt: null,
      exitCode: null,
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

  it("deleteWorkspace hard-removes the row and its sessions so the name slot can be reused", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-db-"));
    dirs.push(dir);
    const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
    store.migrate();
    const repo = {
      id: "repo_delete",
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
    };
    store.insertRepo(repo);
    const workspaceBase = {
      repoId: repo.id,
      name: "reusable",
      branch: "reusable",
      baseBranch: "main",
      source: "scratch" as const,
      kind: "worktree" as const,
      prUrl: null,
      issueKey: null,
      issueTitle: null,
      issueUrl: null,
      slackThreadUrl: null,
      section: "backlog",
      pinned: false,
      lifecycle: "ready" as const,
      dirty: false,
      namespaceId: null,
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
      archivedAt: null,
    };
    store.insertWorkspace({ ...workspaceBase, id: "ws_delete", path: path.join(dir, "worktrees", "reusable") });
    store.insertSession({
      id: "sess_delete",
      workspaceId: "ws_delete",
      runtimeId: "shell",
      displayName: "Shell",
      status: "running",
      transport: "disconnected",
      tmuxSessionName: null,
      tmuxSessionId: null,
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
    });

    store.deleteWorkspace("ws_delete");

    expect(store.listWorkspaces(repo.id)).toEqual([]);
    expect(store.listArchivedWorkspaces().find((w) => w.id === "ws_delete")).toBeUndefined();
    expect(store.listSessions("ws_delete")).toEqual([]);
    // Slot is free — re-inserting the same (repo_id, name) succeeds.
    expect(() =>
      store.insertWorkspace({
        ...workspaceBase,
        id: "ws_delete_2",
        path: path.join(dir, "worktrees", "reusable-2"),
      }),
    ).not.toThrow();
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
      namespaceId: null,
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

  it("round-trips scheduled_agent_runs rows and the queue helpers", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-db-"));
    dirs.push(dir);
    const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
    store.migrate();
    store.insertRepo({
      id: "repo_runs",
      name: "Repo",
      rootPath: path.join(dir, "repo"),
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(dir, "wt"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
      archivedAt: null,
    });
    store.insertScheduledAgent({
      id: "sched_runs",
      name: "Runs",
      description: null,
      scheduleType: "recurring",
      cron: "* * * * *",
      runAt: null,
      repoId: "repo_runs",
      runtimeId: "shell",
      prompt: null,
      workspaceStrategy: "new",
      workspaceName: "runs",
      baseBranch: null,
      runMode: "background",
      backgroundCwd: null,
      overlapPolicy: "queue",
      enabled: true,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunMessage: null,
      lastWorkspaceId: null,
      lastSessionId: null,
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
    });

    // Queued row — startedAt/endedAt/logFilePath null until promotion + close.
    store.insertScheduledAgentRun({
      id: "run_q1",
      scheduledAgentId: "sched_runs",
      status: "queued",
      enqueuedAt: "2026-05-17T01:00:00.000Z",
      startedAt: null,
      endedAt: null,
      message: null,
      workspaceId: null,
      sessionId: null,
      backgroundSessionId: null,
      logFilePath: null,
    });
    // Running row — already promoted.
    store.insertScheduledAgentRun({
      id: "run_running",
      scheduledAgentId: "sched_runs",
      status: "running",
      enqueuedAt: "2026-05-17T00:59:00.000Z",
      startedAt: "2026-05-17T00:59:00.000Z",
      endedAt: null,
      message: null,
      workspaceId: null,
      sessionId: null,
      backgroundSessionId: "bg_running",
      logFilePath: "/tmp/run_running.log",
    });

    // List returns DESC by enqueued_at: q1 (01:00) before running (00:59).
    const runs = store.listScheduledAgentRuns("sched_runs");
    expect(runs.map((r) => r.id)).toEqual(["run_q1", "run_running"]);
    expect(runs[0]?.status).toBe("queued");
    expect(runs[0]?.startedAt).toBeNull();

    // Limit respected.
    expect(store.listScheduledAgentRuns("sched_runs", { limit: 1 }).map((r) => r.id)).toEqual(["run_q1"]);

    // findInFlight ignores queued + terminals; returns the running row.
    expect(store.findInFlightScheduledAgentRun("sched_runs")?.id).toBe("run_running");

    // Queue helpers.
    expect(store.countQueuedScheduledAgentRuns("sched_runs")).toBe(1);
    expect(store.findOldestQueuedScheduledAgentRun("sched_runs")?.id).toBe("run_q1");

    // Promote q1 → running, then list shows two running rows (test fixture only).
    const promoted = store.promoteScheduledAgentRunToRunning("run_q1", {
      startedAt: "2026-05-17T01:00:30.000Z",
      logFilePath: "/tmp/run_q1.log",
    });
    expect(promoted?.status).toBe("running");
    expect(promoted?.startedAt).toBe("2026-05-17T01:00:30.000Z");
    expect(promoted?.logFilePath).toBe("/tmp/run_q1.log");
    expect(store.countQueuedScheduledAgentRuns("sched_runs")).toBe(0);

    // Outcome write.
    const outcome = store.recordScheduledAgentRunOutcome("run_q1", {
      status: "succeeded",
      endedAt: "2026-05-17T01:05:00.000Z",
      message: "done",
    });
    expect(outcome?.status).toBe("succeeded");
    expect(outcome?.endedAt).toBe("2026-05-17T01:05:00.000Z");
    expect(outcome?.message).toBe("done");

    // listInFlight returns only the still-running rows globally.
    expect(store.listInFlightScheduledAgentRuns().map((r) => r.id)).toEqual(["run_running"]);
  });

  it("round-trips background_sessions and filters by scheduledAgentId", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-db-"));
    dirs.push(dir);
    const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
    store.migrate();

    const now = "2026-05-17T00:00:00.000Z";
    store.insertBackgroundSession({
      id: "bg_a",
      scheduledAgentId: "sched_one",
      cwd: "/tmp/a",
      logFilePath: "/tmp/a.log",
      tmuxSessionName: "citadel_bg_a",
      tmuxSessionId: "$1",
      status: "running",
      createdAt: now,
      updatedAt: now,
    });
    store.insertBackgroundSession({
      id: "bg_b",
      scheduledAgentId: "sched_two",
      cwd: "/tmp/b",
      logFilePath: "/tmp/b.log",
      tmuxSessionName: "citadel_bg_b",
      tmuxSessionId: "$2",
      status: "running",
      createdAt: now,
      updatedAt: now,
    });

    expect(store.findBackgroundSessionsByScheduledAgent("sched_one").map((s) => s.id)).toEqual(["bg_a"]);
    expect(store.findBackgroundSessionsByScheduledAgent("sched_two").map((s) => s.id)).toEqual(["bg_b"]);
    expect(
      store
        .listRunningBackgroundSessions()
        .map((s) => s.id)
        .sort(),
    ).toEqual(["bg_a", "bg_b"]);

    const updated = store.updateBackgroundSessionStatus("bg_a", "stopped");
    expect(updated?.status).toBe("stopped");
    expect(store.listRunningBackgroundSessions().map((s) => s.id)).toEqual(["bg_b"]);

    store.deleteBackgroundSession("bg_a");
    expect(store.findBackgroundSession("bg_a")).toBeNull();
  });

  it("deleteScheduledAgentCascade removes runs + background_sessions in one transaction and returns the cleanup metadata", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-db-"));
    dirs.push(dir);
    const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
    store.migrate();
    store.insertRepo({
      id: "repo_cascade",
      name: "Repo",
      rootPath: path.join(dir, "repo"),
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(dir, "wt"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
      archivedAt: null,
    });
    store.insertScheduledAgent({
      id: "sched_cascade",
      name: "Cascade",
      description: null,
      scheduleType: "recurring",
      cron: "0 * * * *",
      runAt: null,
      repoId: "repo_cascade",
      runtimeId: "shell",
      prompt: null,
      workspaceStrategy: "new",
      workspaceName: "casc",
      baseBranch: null,
      runMode: "background",
      backgroundCwd: null,
      overlapPolicy: "skip",
      enabled: true,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunMessage: null,
      lastWorkspaceId: null,
      lastSessionId: null,
      createdAt: "2026-05-17T00:00:00.000Z",
      updatedAt: "2026-05-17T00:00:00.000Z",
    });
    store.insertScheduledAgentRun({
      id: "run_csc_1",
      scheduledAgentId: "sched_cascade",
      status: "succeeded",
      enqueuedAt: "2026-05-17T01:00:00.000Z",
      startedAt: "2026-05-17T01:00:00.000Z",
      endedAt: "2026-05-17T01:01:00.000Z",
      message: null,
      workspaceId: null,
      sessionId: null,
      backgroundSessionId: "bg_csc_1",
      logFilePath: "/tmp/run_csc_1.log",
    });
    store.insertBackgroundSession({
      id: "bg_csc_1",
      scheduledAgentId: "sched_cascade",
      cwd: "/tmp",
      logFilePath: "/tmp/run_csc_1.log",
      tmuxSessionName: "citadel_bg_csc",
      tmuxSessionId: "$5",
      status: "stopped",
      createdAt: "2026-05-17T01:00:00.000Z",
      updatedAt: "2026-05-17T01:01:00.000Z",
    });

    const cleanup = store.deleteScheduledAgentCascade("sched_cascade");
    expect(cleanup).toEqual({
      logFilePaths: ["/tmp/run_csc_1.log"],
      tmuxSessionNames: ["citadel_bg_csc"],
    });
    expect(store.findScheduledAgent("sched_cascade")).toBeNull();
    expect(store.listScheduledAgentRuns("sched_cascade")).toEqual([]);
    expect(store.findBackgroundSessionsByScheduledAgent("sched_cascade")).toEqual([]);

    // Unknown id returns null without throwing.
    expect(store.deleteScheduledAgentCascade("missing")).toBeNull();
  });
});
