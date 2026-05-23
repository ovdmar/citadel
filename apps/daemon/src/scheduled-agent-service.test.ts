import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SqliteStore } from "@citadel/db";
import { OperationService, ScheduledAgentRunner } from "@citadel/operations";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callDaemonMcpTool } from "./daemon-mcp-tool.js";
import { ScheduledAgentService } from "./scheduled-agent-service.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("ScheduledAgentService", () => {
  it("emits scheduled-agent events and maps runner failures into typed errors", async () => {
    const { service, runner } = createService();
    const repo = createRepo();

    const create = service.create({
      name: "Daily",
      cron: "0 9 * * *",
      repoId: repo.id,
      runtimeId: "shell",
      workspaceStrategy: "existing",
      workspaceName: "daily",
    });
    expect(create.ok).toBe(true);
    if (!create.ok) throw new Error("expected create to succeed");

    // create emits scheduled-agent.updated with { id, agent }.
    expect(emits).toContainEqual(["scheduled-agent.updated", { id: create.value.id, agent: create.value }]);

    // Unknown ids surface as a typed error rather than throwing.
    expect(service.update("missing_id", { enabled: false })).toEqual({ ok: false, error: "scheduled_agent_not_found" });
    expect(service.delete("missing_id")).toEqual({ ok: false, error: "scheduled_agent_not_found" });

    // delete emits the removal event and runner.find returns null.
    const removed = service.delete(create.value.id);
    expect(removed).toEqual({ ok: true, value: true });
    expect(emits).toContainEqual(["scheduled-agent.updated", { id: create.value.id, removed: true }]);
    expect(runner.find(create.value.id)).toBeNull();
  });

  it("callDaemonMcpTool maps service results into the MCP envelope shape", async () => {
    const { service, runner, store } = createService();
    const repo = createRepo();

    const deps = {
      config: { runtimes: [{ id: "shell", displayName: "Shell", command: "bash", args: [] }] } as never,
      store,
      operations: {} as never,
      ttyd: {} as never,
      scheduledAgents: runner,
      scheduledAgentService: service,
      providerCache: new Map(),
      emit: () => {},
    };

    const created = (await callDaemonMcpTool(deps, {
      name: "create_scheduled_agent",
      arguments: {
        name: "From MCP",
        cron: "0 9 * * *",
        repoId: repo.id,
        runtimeId: "shell",
        workspaceStrategy: "existing",
        workspaceName: "mcp",
      },
    })) as { scheduledAgent: { id: string } };
    expect(created.scheduledAgent.id).toMatch(/^sched_/);

    expect(await callDaemonMcpTool(deps, { name: "update_scheduled_agent", arguments: {} })).toEqual({
      error: "id_required",
    });
    expect(await callDaemonMcpTool(deps, { name: "delete_scheduled_agent", arguments: { id: "missing" } })).toEqual({
      error: "scheduled_agent_not_found",
    });

    const removed = (await callDaemonMcpTool(deps, {
      name: "delete_scheduled_agent",
      arguments: { id: created.scheduledAgent.id },
    })) as { removed: boolean };
    expect(removed.removed).toBe(true);
  });
});

let emits: Array<[string, unknown]> = [];

function createService() {
  emits = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-sched-svc-"));
  dirs.push(dir);
  const store = new SqliteStore(path.join(dir, "citadel.sqlite"));
  store.migrate();
  const operations = new OperationService(store, {
    hooks: [],
    repoDefaults: { setupHookIds: [], teardownHookIds: [] },
    commandPolicy: { hookTimeoutMs: 5000, allowDestructiveWorkspaceCleanup: false },
  });
  const runner = new ScheduledAgentRunner({
    store,
    operations,
    getRuntime: () => ({ id: "shell", displayName: "Shell", command: "bash", args: [] }),
  });
  const service = new ScheduledAgentService(runner, (type, payload) => {
    emits.push([type, payload]);
  });
  // expose store + operations so the MCP test can register a real repo
  // without rebuilding the fixture from scratch.
  fixtureStore = store;
  fixtureOperations = operations;
  return { service, runner, store, operations };
}

let fixtureStore!: SqliteStore;
let fixtureOperations!: OperationService;

function createRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-sched-repo-"));
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
  return fixtureOperations.registerRepo({ rootPath: repoPath });
}

// `vi` is imported above so this file can be type-checked even if a future
// test wants fake timers; not used today but keeps the import in scope.
void vi;
