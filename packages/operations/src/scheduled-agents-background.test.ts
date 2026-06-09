import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "@citadel/db";
import { afterEach, describe, expect, it } from "vitest";
import { OperationService } from "./index.js";
import { ScheduledAgentRunner } from "./scheduled-agents.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("ScheduledAgentRunner (background runMode)", () => {
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
      getRuntime: () => ({ id: "test-agent", displayName: "Test Agent", command: "bash", args: [] }),
      killTmuxSession: (name) => killed.push(name),
    });
    const agent = runner.create({
      name: "Boot bg",
      cron: "* * * * *",
      repoId: repo.id,
      runtimeId: "test-agent",
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
      getRuntime: () => ({ id: "test-agent", displayName: "Test Agent", command: "bash", args: [] }),
      createBackgroundSession: async () => {
        createCalled += 1;
        throw new Error("should not be called");
      },
    });
    const agent = runner.create({
      name: "BG bad cwd",
      cron: "0 9 * * *",
      repoId: repo.id,
      runtimeId: "test-agent",
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
      getRuntime: () => ({ id: "test-agent", displayName: "Test Agent", command: "bash", args: [] }),
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
      runtimeId: "test-agent",
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-sched-bg-"));
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
