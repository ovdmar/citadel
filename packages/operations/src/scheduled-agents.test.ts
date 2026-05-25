import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "@citadel/db";
import { afterEach, describe, expect, it } from "vitest";
import { OperationService } from "./index.js";
import { ScheduledAgentRunner, cronMatches, parseCronExpression } from "./scheduled-agents.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseCronExpression", () => {
  it("parses wildcards, steps, lists, and ranges", () => {
    const everyMinute = parseCronExpression("* * * * *");
    expect(everyMinute.domWild).toBe(true);
    expect(everyMinute.dowWild).toBe(true);
    expect(everyMinute.minute.has(0)).toBe(true);
    expect(everyMinute.minute.has(59)).toBe(true);

    const step = parseCronExpression("*/15 * * * *");
    expect([...step.minute].sort((a, b) => a - b)).toEqual([0, 15, 30, 45]);

    const list = parseCronExpression("0,30 9-17 * * 1-5");
    expect([...list.minute].sort((a, b) => a - b)).toEqual([0, 30]);
    expect(list.hour.has(9) && list.hour.has(17)).toBe(true);
    expect([...list.dow].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(list.domWild).toBe(true);
  });

  it("rejects invalid expressions", () => {
    expect(() => parseCronExpression("60 * * * *")).toThrow();
    expect(() => parseCronExpression("* * *")).toThrow();
    expect(() => parseCronExpression("*/0 * * * *")).toThrow();
  });

  it("matches minute floors against expressions", () => {
    const expr = parseCronExpression("30 14 * * *");
    const match = new Date(2025, 4, 22, 14, 30, 0);
    const skip = new Date(2025, 4, 22, 14, 31, 0);
    expect(cronMatches(expr, match)).toBe(true);
    expect(cronMatches(expr, skip)).toBe(false);
  });

  it("honours the cron DOM/DOW OR rule", () => {
    const expr = parseCronExpression("0 0 1 * 0");
    const firstOfMonth = new Date(2025, 0, 1, 0, 0, 0); // Wed
    const sunday = new Date(2025, 0, 5, 0, 0, 0); // Sun
    const otherDay = new Date(2025, 0, 7, 0, 0, 0); // Tue
    expect(cronMatches(expr, firstOfMonth)).toBe(true);
    expect(cronMatches(expr, sunday)).toBe(true);
    expect(cronMatches(expr, otherDay)).toBe(false);
  });
});

describe("ScheduledAgentRunner", () => {
  it("creates, lists, updates, and deletes scheduled agents", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const operations = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = operations.registerRepo({ rootPath: fixture.repoPath });
    const runner = new ScheduledAgentRunner({
      store,
      operations,
      getRuntime: () => ({ id: "shell", displayName: "Shell", command: "bash", args: [] }),
      dataDir: fixture.dir,
    });

    const agent = runner.create({
      name: "Daily sweep",
      cron: "0 9 * * *",
      repoId: repo.id,
      runtimeId: "shell",
      workspaceStrategy: "existing",
      workspaceName: "daily-sweep",
    });
    expect(agent.lastRunStatus).toBe("never");
    expect(runner.list()).toHaveLength(1);

    const updated = runner.update(agent.id, { enabled: false, description: "paused while debugging" });
    expect(updated?.enabled).toBe(false);
    expect(updated?.description).toBe("paused while debugging");

    expect(runner.delete(agent.id)).toEqual({ ok: true });
    expect(runner.list()).toHaveLength(0);
  });

  it("validates cron expressions and runtime references on create", () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const operations = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = operations.registerRepo({ rootPath: fixture.repoPath });
    const runner = new ScheduledAgentRunner({
      store,
      operations,
      getRuntime: (id) => (id === "shell" ? { id, displayName: "Shell", command: "bash", args: [] } : undefined),
      dataDir: fixture.dir,
    });

    expect(() =>
      runner.create({
        name: "Bad cron",
        cron: "not-a-cron",
        repoId: repo.id,
        runtimeId: "shell",
        workspaceStrategy: "new",
        workspaceName: "bad",
      }),
    ).toThrow();

    expect(() =>
      runner.create({
        name: "Missing runtime",
        cron: "* * * * *",
        repoId: repo.id,
        runtimeId: "ghost",
        workspaceStrategy: "new",
        workspaceName: "miss",
      }),
    ).toThrow();
  });

  it("records run failures when the runtime configuration disappears", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const operations = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = operations.registerRepo({ rootPath: fixture.repoPath });
    let runtimeAvailable = true;
    const runner = new ScheduledAgentRunner({
      store,
      operations,
      getRuntime: () =>
        runtimeAvailable ? { id: "shell", displayName: "Shell", command: "bash", args: [] } : undefined,
      dataDir: fixture.dir,
    });
    const agent = runner.create({
      name: "Failing run",
      cron: "* * * * *",
      repoId: repo.id,
      runtimeId: "shell",
      workspaceStrategy: "existing",
      workspaceName: "failing",
    });

    runtimeAvailable = false;
    const result = await runner.runNow(agent.id);
    expect(result.kind).toBe("ran");
    if (result.kind === "ran") expect(result.status).toBe("failed");
    const stored = runner.find(agent.id);
    expect(stored?.lastRunStatus).toBe("failed");
    expect(stored?.lastRunMessage).toContain("Runtime");
  });

  it("fires one-shot agents only after their runAt and auto-disables them", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const operations = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = operations.registerRepo({ rootPath: fixture.repoPath });
    let runtimeAvailable = true;
    const runner = new ScheduledAgentRunner({
      store,
      operations,
      getRuntime: () =>
        runtimeAvailable ? { id: "shell", displayName: "Shell", command: "bash", args: [] } : undefined,
      dataDir: fixture.dir,
    });

    const runAt = new Date(2030, 0, 1, 9, 0, 0);
    const agent = runner.create({
      name: "One-shot",
      scheduleType: "once",
      runAt: runAt.toISOString(),
      repoId: repo.id,
      runtimeId: "shell",
      workspaceStrategy: "existing",
      workspaceName: "one-shot",
    });
    expect(agent.scheduleType).toBe("once");
    expect(agent.cron).toBeNull();
    expect(agent.runAt).toBe(runAt.toISOString());

    // Before runAt: nothing fires.
    runtimeAvailable = false;
    const before = await runner.tick(new Date(runAt.getTime() - 60_000));
    expect(before).toEqual([]);

    // After runAt: it fires exactly once and the runner disables it.
    const fired = await runner.tick(new Date(runAt.getTime() + 60_000));
    expect(fired).toEqual([agent.id]);
    const afterFire = runner.find(agent.id);
    expect(afterFire?.enabled).toBe(false);
    expect(afterFire?.lastRunStatus).toBe("failed");

    const repeat = await runner.tick(new Date(runAt.getTime() + 120_000));
    expect(repeat).toEqual([]);
  });

  it("flips scheduleType, clears the unused field, and re-arms lastRunStatus", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const operations = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = operations.registerRepo({ rootPath: fixture.repoPath });
    const runner = new ScheduledAgentRunner({
      store,
      operations,
      getRuntime: () => ({ id: "shell", displayName: "Shell", command: "bash", args: [] }),
      dataDir: fixture.dir,
    });

    // Start recurring.
    const recurring = runner.create({
      name: "Recurring",
      cron: "0 9 * * *",
      repoId: repo.id,
      runtimeId: "shell",
      workspaceStrategy: "existing",
      workspaceName: "ws",
    });
    expect(recurring.cron).toBe("0 9 * * *");

    // Flip to one-shot.
    const future = new Date(2030, 0, 1, 9, 0, 0).toISOString();
    const asOnce = runner.update(recurring.id, { scheduleType: "once", runAt: future });
    expect(asOnce).toMatchObject({ scheduleType: "once", runAt: future, cron: null });

    // Flip back to recurring with a fresh cron.
    const backToRecurring = runner.update(recurring.id, {
      scheduleType: "recurring",
      cron: "*/30 * * * *",
    });
    expect(backToRecurring).toMatchObject({ scheduleType: "recurring", cron: "*/30 * * * *", runAt: null });

    // Switching scheduleType without supplying the matching field throws.
    expect(() => runner.update(recurring.id, { scheduleType: "once" })).toThrow(/runAt/);

    // Re-arm: simulate a fired one-shot, then PATCH a new runAt and confirm
    // lastRunStatus rewinds to 'never' so the next tick can fire again.
    const oneShot = runner.create({
      name: "One",
      scheduleType: "once",
      runAt: new Date(2030, 0, 1, 9, 0, 0).toISOString(),
      repoId: repo.id,
      runtimeId: "shell",
      workspaceStrategy: "existing",
      workspaceName: "ws-once",
    });
    store.recordScheduledAgentRun(oneShot.id, {
      lastRunAt: new Date().toISOString(),
      lastRunStatus: "succeeded",
      lastRunMessage: "done",
    });
    const rearmed = runner.update(oneShot.id, { runAt: new Date(2030, 5, 1, 9, 0, 0).toISOString() });
    expect(rearmed).toMatchObject({ lastRunStatus: "never", lastRunMessage: null });
  });

  it("rejects one-shot creation without a runAt and recurring creation without a cron", () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const operations = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = operations.registerRepo({ rootPath: fixture.repoPath });
    const runner = new ScheduledAgentRunner({
      store,
      operations,
      getRuntime: () => ({ id: "shell", displayName: "Shell", command: "bash", args: [] }),
      dataDir: fixture.dir,
    });

    expect(() =>
      runner.create({
        name: "Missing runAt",
        scheduleType: "once",
        repoId: repo.id,
        runtimeId: "shell",
        workspaceStrategy: "new",
        workspaceName: "noop",
      }),
    ).toThrow(/runAt/);

    expect(() =>
      runner.create({
        name: "Missing cron",
        scheduleType: "recurring",
        repoId: repo.id,
        runtimeId: "shell",
        workspaceStrategy: "new",
        workspaceName: "noop",
      }),
    ).toThrow(/cron/);
  });

  it("skips ticks that already fired in the current minute", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const operations = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = operations.registerRepo({ rootPath: fixture.repoPath });
    let runtimeAvailable = true;
    const runner = new ScheduledAgentRunner({
      store,
      operations,
      getRuntime: () =>
        runtimeAvailable ? { id: "shell", displayName: "Shell", command: "bash", args: [] } : undefined,
      dataDir: fixture.dir,
    });
    const agent = runner.create({
      name: "Every minute",
      cron: "* * * * *",
      repoId: repo.id,
      runtimeId: "shell",
      workspaceStrategy: "existing",
      workspaceName: "every-min",
    });
    runtimeAvailable = false; // make subsequent runs fail before spawning tmux

    const now = new Date(2025, 4, 22, 10, 30, 30);
    const firedFirst = await runner.tick(now);
    expect(firedFirst).toEqual([agent.id]);
    const firedAgain = await runner.tick(new Date(2025, 4, 22, 10, 30, 50));
    expect(firedAgain).toEqual([]);

    const nextMinute = new Date(2025, 4, 22, 10, 31, 5);
    const firedNext = await runner.tick(nextMinute);
    expect(firedNext).toEqual([agent.id]);
  });

  it("every runOnce writes a scheduled_agent_runs row with status running→failed and updates the cache", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const operations = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = operations.registerRepo({ rootPath: fixture.repoPath });
    let runtimeAvailable = true;
    const runner = new ScheduledAgentRunner({
      store,
      operations,
      dataDir: fixture.dir,
      getRuntime: () =>
        runtimeAvailable ? { id: "shell", displayName: "Shell", command: "bash", args: [] } : undefined,
    });
    const agent = runner.create({
      name: "Runs",
      cron: "* * * * *",
      repoId: repo.id,
      runtimeId: "shell",
      workspaceStrategy: "existing",
      workspaceName: "runs",
    });
    runtimeAvailable = false; // force the run to fail before tmux spawn

    const result = await runner.runNow(agent.id);
    expect(result.kind).toBe("ran");
    if (result.kind === "ran") {
      expect(result.status).toBe("failed");
      expect(result.runId).toMatch(/^run_/);
    }
    const runs = store.listScheduledAgentRuns(agent.id);
    expect(runs.map((r) => r.status)).toEqual(["failed"]);
    expect(runs[0]?.startedAt).not.toBeNull();
    expect(runs[0]?.endedAt).not.toBeNull();
    // Denormalized cache mirrors the same outcome.
    expect(store.findScheduledAgent(agent.id)?.lastRunStatus).toBe("failed");
  });

  it("tick with overlapPolicy='queue' enqueues a run, drain promotes it after the in-flight completes", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const operations = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = operations.registerRepo({ rootPath: fixture.repoPath });
    let runtimeAvailable = true;
    const runner = new ScheduledAgentRunner({
      store,
      operations,
      dataDir: fixture.dir,
      getRuntime: () =>
        runtimeAvailable ? { id: "shell", displayName: "Shell", command: "bash", args: [] } : undefined,
    });
    const agent = runner.create({
      name: "Queue",
      cron: "* * * * *",
      repoId: repo.id,
      runtimeId: "shell",
      workspaceStrategy: "existing",
      workspaceName: "queue",
      overlapPolicy: "queue",
    });
    runtimeAvailable = false; // execute() returns failure without spawning tmux

    // Manually insert an in-flight run so the next tick sees overlap.
    store.insertScheduledAgentRun({
      id: "run_inflight",
      scheduledAgentId: agent.id,
      status: "running",
      enqueuedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      message: null,
      workspaceId: null,
      sessionId: null,
      backgroundSessionId: null,
      logFilePath: null,
    });

    const fired = await runner.tick(new Date());
    // Synchronous tick fires nothing (the in-flight blocks); queued row added.
    expect(fired).toEqual([]);
    expect(store.countQueuedScheduledAgentRuns(agent.id)).toBe(1);

    // Complete the in-flight, then drain.
    store.recordScheduledAgentRunOutcome("run_inflight", {
      status: "succeeded",
      endedAt: new Date().toISOString(),
      message: "ok",
    });
    await runner.drainQueue(agent.id);
    // The queued row promoted, executed (failed because runtime undefined), and terminated.
    const runs = store.listScheduledAgentRuns(agent.id);
    // Both rows now terminal — drain consumed the queued one.
    expect(runs.map((r) => r.status).sort()).toEqual(["failed", "succeeded"]);
    expect(store.countQueuedScheduledAgentRuns(agent.id)).toBe(0);
  });

  it("tick with overlapPolicy='skip' and an in-flight run drops the fire and emits skipped_overlap", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const operations = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = operations.registerRepo({ rootPath: fixture.repoPath });
    const activity: Array<{ type: string }> = [];
    let runtimeAvailable = true;
    const runner = new ScheduledAgentRunner({
      store,
      operations,
      dataDir: fixture.dir,
      getRuntime: () =>
        runtimeAvailable ? { id: "shell", displayName: "Shell", command: "bash", args: [] } : undefined,
      recordActivity: (event) => activity.push({ type: event.type }),
    });
    const agent = runner.create({
      name: "Skip",
      cron: "* * * * *",
      repoId: repo.id,
      runtimeId: "shell",
      workspaceStrategy: "existing",
      workspaceName: "skip",
      // overlapPolicy defaults to 'skip'.
    });
    runtimeAvailable = false;
    store.insertScheduledAgentRun({
      id: "run_inflight2",
      scheduledAgentId: agent.id,
      status: "running",
      enqueuedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      message: null,
      workspaceId: null,
      sessionId: null,
      backgroundSessionId: null,
      logFilePath: null,
    });
    await runner.tick(new Date());
    expect(activity.some((e) => e.type === "scheduled-agent.skipped_overlap")).toBe(true);
    // No new row inserted — only the seeded in-flight row exists.
    expect(store.listScheduledAgentRuns(agent.id).map((r) => r.id)).toEqual(["run_inflight2"]);
  });

  it("runNow returns the right envelope for ran / queued / skipped / queue_full", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const operations = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = operations.registerRepo({ rootPath: fixture.repoPath });
    let runtimeAvailable = true;
    const runner = new ScheduledAgentRunner({
      store,
      operations,
      dataDir: fixture.dir,
      getRuntime: () =>
        runtimeAvailable ? { id: "shell", displayName: "Shell", command: "bash", args: [] } : undefined,
    });
    const skipAgent = runner.create({
      name: "RNskip",
      cron: "* * * * *",
      repoId: repo.id,
      runtimeId: "shell",
      workspaceStrategy: "existing",
      workspaceName: "rn-skip",
    });
    const queueAgent = runner.create({
      name: "RNqueue",
      cron: "* * * * *",
      repoId: repo.id,
      runtimeId: "shell",
      workspaceStrategy: "existing",
      workspaceName: "rn-queue",
      overlapPolicy: "queue",
    });
    runtimeAvailable = false;

    // Seed in-flight on both.
    for (const id of [skipAgent.id, queueAgent.id]) {
      store.insertScheduledAgentRun({
        id: `inflight_${id}`,
        scheduledAgentId: id,
        status: "running",
        enqueuedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        endedAt: null,
        message: null,
        workspaceId: null,
        sessionId: null,
        backgroundSessionId: null,
        logFilePath: null,
      });
    }

    // skip → kind=skipped_overlap.
    expect((await runner.runNow(skipAgent.id)).kind).toBe("skipped_overlap");

    // queue → kind=queued.
    const queued = await runner.runNow(queueAgent.id);
    expect(queued.kind).toBe("queued");
    if (queued.kind === "queued") expect(queued.queuePosition).toBe(1);

    // Fill the queue to the cap then test queue_full.
    for (let i = 0; i < 9; i += 1) {
      await runner.runNow(queueAgent.id);
    }
    expect(store.countQueuedScheduledAgentRuns(queueAgent.id)).toBe(10);
    const overflow = await runner.runNow(queueAgent.id);
    expect(overflow.kind).toBe("queue_full");
    if (overflow.kind === "queue_full") expect(overflow.limit).toBe(10);
  });

  it("delete returns in_flight_run when a run is executing; cascades on success", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const operations = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = operations.registerRepo({ rootPath: fixture.repoPath });
    const killedSessions: string[] = [];
    const runner = new ScheduledAgentRunner({
      store,
      operations,
      dataDir: fixture.dir,
      getRuntime: () => ({ id: "shell", displayName: "Shell", command: "bash", args: [] }),
      killTmuxSession: (name) => killedSessions.push(name),
    });
    const agent = runner.create({
      name: "Delete",
      cron: "0 9 * * *",
      repoId: repo.id,
      runtimeId: "shell",
      workspaceStrategy: "existing",
      workspaceName: "del",
    });

    // In-flight → cannot delete.
    store.insertScheduledAgentRun({
      id: "del_inflight",
      scheduledAgentId: agent.id,
      status: "running",
      enqueuedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      message: null,
      workspaceId: null,
      sessionId: null,
      backgroundSessionId: null,
      logFilePath: null,
    });
    expect(runner.delete(agent.id)).toEqual({ ok: false, error: "in_flight_run" });

    // Close the in-flight; seed a background session + a log file on disk.
    store.recordScheduledAgentRunOutcome("del_inflight", {
      status: "failed",
      endedAt: new Date().toISOString(),
      message: "stopped",
    });
    const logPath = path.join(fixture.dir, "scheduled-runs", agent.id, "del_inflight.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, "stuff");
    store.recordScheduledAgentRunOutcome("del_inflight", {
      status: "failed",
      endedAt: new Date().toISOString(),
      message: "stopped",
      backgroundSessionId: "bg_del",
    });
    store.insertBackgroundSession({
      id: "bg_del",
      scheduledAgentId: agent.id,
      cwd: fixture.repoPath,
      logFilePath: logPath,
      tmuxSessionName: "citadel_bg_del",
      tmuxSessionId: "$9",
      status: "stopped",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    // Update the run row to point at the log path so the cascade picks it up.
    store.recordScheduledAgentRunOutcome("del_inflight", {
      status: "failed",
      endedAt: new Date().toISOString(),
      message: "stopped",
    });
    // The run row's logFilePath was set by promoteScheduledAgentRunToRunning
    // when fireImmediately ran — but our manual insert above did not promote.
    // Manually set it via a direct query.
    store.exec(`UPDATE scheduled_agent_runs SET log_file_path = '${logPath}' WHERE id = 'del_inflight'`);

    const deleted = runner.delete(agent.id);
    expect(deleted).toEqual({ ok: true });
    expect(fs.existsSync(logPath)).toBe(false);
    expect(killedSessions).toEqual(["citadel_bg_del"]);
    expect(store.findScheduledAgent(agent.id)).toBeNull();
  });

  it("recoverInFlightRuns flips orphaned 'running' rows to 'failed' and drains queued rows", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const operations = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = operations.registerRepo({ rootPath: fixture.repoPath });
    let runtimeAvailable = true;
    const runner = new ScheduledAgentRunner({
      store,
      operations,
      dataDir: fixture.dir,
      getRuntime: () =>
        runtimeAvailable ? { id: "shell", displayName: "Shell", command: "bash", args: [] } : undefined,
    });
    const agent = runner.create({
      name: "Boot",
      cron: "* * * * *",
      repoId: repo.id,
      runtimeId: "shell",
      workspaceStrategy: "existing",
      workspaceName: "boot",
      overlapPolicy: "queue",
    });
    runtimeAvailable = false;

    // Seed an orphan running row + a queued row waiting on it.
    store.insertScheduledAgentRun({
      id: "boot_running",
      scheduledAgentId: agent.id,
      status: "running",
      enqueuedAt: new Date(Date.now() - 60_000).toISOString(),
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: null,
      message: null,
      workspaceId: null,
      sessionId: null,
      backgroundSessionId: null,
      logFilePath: null,
    });
    store.insertScheduledAgentRun({
      id: "boot_queued",
      scheduledAgentId: agent.id,
      status: "queued",
      enqueuedAt: new Date().toISOString(),
      startedAt: null,
      endedAt: null,
      message: null,
      workspaceId: null,
      sessionId: null,
      backgroundSessionId: null,
      logFilePath: null,
    });

    await runner.recoverInFlightRuns();

    const running = store.findScheduledAgentRun("boot_running");
    expect(running?.status).toBe("failed");
    expect(running?.message).toBe("daemon_restarted_during_run");
    // Denormalized cache also updated (this run is the most-recent for the agent).
    expect(store.findScheduledAgent(agent.id)?.lastRunStatus).toBe("failed");
    // Queue drained — the queued row should be terminal (failed because getRuntime returns undefined).
    const queued = store.findScheduledAgentRun("boot_queued");
    expect(queued?.status).toBe("failed");
    expect(store.countQueuedScheduledAgentRuns(agent.id)).toBe(0);
  });

  it("recoverInFlightRuns kills tmux + deletes background_sessions for orphans with a backgroundSessionId", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const operations = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = operations.registerRepo({ rootPath: fixture.repoPath });
    const killed: string[] = [];
    const runner = new ScheduledAgentRunner({
      store,
      operations,
      dataDir: fixture.dir,
      getRuntime: () => ({ id: "shell", displayName: "Shell", command: "bash", args: [] }),
      killTmuxSession: (name) => killed.push(name),
    });
    const agent = runner.create({
      name: "Boot bg",
      cron: "* * * * *",
      repoId: repo.id,
      runtimeId: "shell",
      workspaceStrategy: "existing",
      workspaceName: "bg-boot",
    });
    store.insertScheduledAgentRun({
      id: "boot_bg_running",
      scheduledAgentId: agent.id,
      status: "running",
      enqueuedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      endedAt: null,
      message: null,
      workspaceId: null,
      sessionId: null,
      backgroundSessionId: "bg_orphan",
      logFilePath: null,
    });
    store.insertBackgroundSession({
      id: "bg_orphan",
      scheduledAgentId: agent.id,
      cwd: fixture.repoPath,
      logFilePath: path.join(fixture.dir, "orphan.log"),
      tmuxSessionName: "citadel_bg_orphan",
      tmuxSessionId: "$11",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    await runner.recoverInFlightRuns();
    expect(killed).toEqual(["citadel_bg_orphan"]);
    expect(store.findBackgroundSession("bg_orphan")).toBeNull();
    expect(store.findScheduledAgentRun("boot_bg_running")?.status).toBe("failed");
  });

  it("execute background: missing cwd records 'background_cwd_missing' without spawning a session", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const operations = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = operations.registerRepo({ rootPath: fixture.repoPath });
    let createCalled = 0;
    const runner = new ScheduledAgentRunner({
      store,
      operations,
      dataDir: fixture.dir,
      getRuntime: () => ({ id: "shell", displayName: "Shell", command: "bash", args: [] }),
      createBackgroundSession: async () => {
        createCalled += 1;
        throw new Error("should not be called");
      },
    });
    const agent = runner.create({
      name: "BG bad cwd",
      cron: "0 9 * * *",
      repoId: repo.id,
      runtimeId: "shell",
      workspaceStrategy: "existing",
      workspaceName: "bg-bad",
      runMode: "background",
      backgroundCwd: "/tmp/citadel-this-path-does-not-exist-xyz",
    });
    const result = await runner.runNow(agent.id);
    expect(result.kind).toBe("ran");
    if (result.kind === "ran") expect(result.status).toBe("failed");
    const runs = store.listScheduledAgentRuns(agent.id);
    expect(runs[0]?.message).toContain("background_cwd_missing");
    expect(createCalled).toBe(0);
  });

  it("fireImmediately background success records backgroundSessionId on run row + cache", async () => {
    const fixture = createGitFixture();
    const store = new SqliteStore(path.join(fixture.dir, "citadel.sqlite"));
    store.migrate();
    const operations = new OperationService(store, {
      hooks: [],
      repoDefaults: { setupHookIds: [], teardownHookIds: [] },
      commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
    });
    const repo = operations.registerRepo({ rootPath: fixture.repoPath });
    const runner = new ScheduledAgentRunner({
      store,
      operations,
      dataDir: fixture.dir,
      getRuntime: () => ({ id: "shell", displayName: "Shell", command: "bash", args: [] }),
      createBackgroundSession: async () => ({
        id: "bg_stub_1",
        scheduledAgentId: "sched_x",
        cwd: fixture.repoPath,
        logFilePath: path.join(fixture.dir, "stub.log"),
        tmuxSessionName: "citadel_bg_stub",
        tmuxSessionId: "$77",
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    });
    const agent = runner.create({
      name: "BG ok",
      cron: "0 9 * * *",
      repoId: repo.id,
      runtimeId: "shell",
      workspaceStrategy: "existing",
      workspaceName: "bg-ok",
      runMode: "background",
    });
    const result = await runner.runNow(agent.id);
    expect(result.kind).toBe("ran");
    if (result.kind === "ran") {
      expect(result.status).toBe("succeeded");
      expect(result.backgroundSessionId).toBe("bg_stub_1");
      expect(result.workspaceId).toBeNull();
    }
    const runs = store.listScheduledAgentRuns(agent.id);
    expect(runs[0]?.backgroundSessionId).toBe("bg_stub_1");
    expect(runs[0]?.workspaceId).toBeNull();
    expect(store.findScheduledAgent(agent.id)?.lastRunStatus).toBe("succeeded");
  });
});

function createGitFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-sched-"));
  dirs.push(dir);
  const repoPath = path.join(dir, "repo");
  fs.mkdirSync(repoPath);
  execFileSync("git", ["init"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Citadel Test"], { cwd: repoPath, stdio: "pipe" });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["branch", "-M", "main"], { cwd: repoPath, stdio: "pipe" });
  return { dir, repoPath };
}
