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

    expect(runner.delete(agent.id)).toBe(true);
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
    const result = await runner.runOnce(agent.id);
    expect(result.status).toBe("failed");
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
