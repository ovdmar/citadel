import { execFileSync } from "node:child_process";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "@citadel/config";
import { SqliteStore } from "@citadel/db";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeFixtureDir(dir);
});

process.env.CITADEL_DISABLE_REAPER = "1";
process.env.CITADEL_DISABLE_SCHEDULER = "1";

describe("scheduled agent routes", () => {
  it("manages scheduled agents through CRUD and manual-run endpoints", async () => {
    const fixture = createFixture();
    const git = createGitRepo(fixture.config.dataDir);
    const now = new Date().toISOString();
    fixture.store.insertRepo({
      id: "repo_sched",
      name: "Sched Repo",
      rootPath: git.repoPath,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const empty = await getJson<{ scheduledAgents: unknown[] }>(`${baseUrl}/api/scheduled-agents`);
      expect(empty.scheduledAgents).toEqual([]);

      const created = await postJson<{ scheduledAgent: { id: string; enabled: boolean } }>(
        `${baseUrl}/api/scheduled-agents`,
        {
          name: "Daily sweep",
          cron: "0 9 * * *",
          repoId: "repo_sched",
          runtimeId: "shell",
          workspaceStrategy: "existing",
          workspaceName: "sched-target",
        },
      );
      expect(created.scheduledAgent.enabled).toBe(true);

      const invalid = await fetch(`${baseUrl}/api/scheduled-agents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Bad",
          cron: "not-cron",
          repoId: "repo_sched",
          runtimeId: "shell",
          workspaceStrategy: "new",
          workspaceName: "bad",
        }),
      });
      expect(invalid.status).toBe(400);

      const patched = await fetch(`${baseUrl}/api/scheduled-agents/${created.scheduledAgent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      });
      expect(patched.status).toBe(200);
      expect((await patched.json()) as { scheduledAgent: { enabled: boolean } }).toMatchObject({
        scheduledAgent: { enabled: false },
      });

      const runResponse = await fetch(`${baseUrl}/api/scheduled-agents/${created.scheduledAgent.id}/run`, {
        method: "POST",
      });
      expect([202, 424]).toContain(runResponse.status);
      const runBody = (await runResponse.json()) as { scheduledAgent: { lastRunStatus: string } };
      expect(["succeeded", "failed"]).toContain(runBody.scheduledAgent.lastRunStatus);

      const removed = await fetch(`${baseUrl}/api/scheduled-agents/${created.scheduledAgent.id}`, {
        method: "DELETE",
      });
      expect(removed.status).toBe(202);

      const missing = await fetch(`${baseUrl}/api/scheduled-agents/missing_id`, { method: "DELETE" });
      expect(missing.status).toBe(404);

      // Re-create the agent so we can exercise the in-flight DELETE 409 path.
      const recreated = await postJson<{ scheduledAgent: { id: string } }>(`${baseUrl}/api/scheduled-agents`, {
        name: "Inflight delete",
        cron: "0 9 * * *",
        repoId: "repo_sched",
        runtimeId: "shell",
        workspaceStrategy: "existing",
        workspaceName: "sched-target",
      });
      fixture.store.insertScheduledAgentRun({
        id: "inflight_run_test",
        scheduledAgentId: recreated.scheduledAgent.id,
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
      const inflightDelete = await fetch(`${baseUrl}/api/scheduled-agents/${recreated.scheduledAgent.id}`, {
        method: "DELETE",
      });
      expect(inflightDelete.status).toBe(409);
      expect((await inflightDelete.json()) as { error: string }).toEqual({ error: "in_flight_run" });
    } finally {
      await closeServer(server);
    }
  }, 45_000);

  it("GET /runs returns the per-agent run rows; GET /log slices the log file; both 404 when the run doesn't belong to the agent", async () => {
    const fixture = createFixture();
    const git = createGitRepo(fixture.config.dataDir);
    const now = new Date().toISOString();
    fixture.store.insertRepo({
      id: "repo_runs",
      name: "Sched repo",
      rootPath: git.repoPath,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const created = await postJson<{ scheduledAgent: { id: string } }>(`${baseUrl}/api/scheduled-agents`, {
        name: "Runs",
        cron: "0 9 * * *",
        repoId: "repo_runs",
        runtimeId: "shell",
        workspaceStrategy: "existing",
        workspaceName: "runs-target",
      });
      const agentId = created.scheduledAgent.id;

      // Seed a terminal run row + a log file on disk so /log has something to slice.
      // Use a 1024-byte file so we can exercise the maxBytes floor (256) and
      // tail-fetch via offset.
      const runId = "run_test_log";
      const logDir = path.join(fixture.config.dataDir, "scheduled-runs", agentId);
      fs.mkdirSync(logDir, { recursive: true });
      const logPath = path.join(logDir, `${runId}.log`);
      const content = "x".repeat(1024);
      fs.writeFileSync(logPath, content);
      fixture.store.insertScheduledAgentRun({
        id: runId,
        scheduledAgentId: agentId,
        status: "succeeded",
        enqueuedAt: now,
        startedAt: now,
        endedAt: now,
        message: "ok",
        workspaceId: null,
        sessionId: null,
        backgroundSessionId: null,
        logFilePath: logPath,
      });

      const list = await getJson<{ runs: Array<{ id: string }> }>(`${baseUrl}/api/scheduled-agents/${agentId}/runs`);
      expect(list.runs.map((r) => r.id)).toContain(runId);

      // maxBytes=256 (floor) → first 256 bytes, truncated=true (1024 > 256).
      const log = await getJson<{ content: string; bytesRead: number; nextOffset: number; truncated: boolean }>(
        `${baseUrl}/api/scheduled-agents/${agentId}/runs/${runId}/log?maxBytes=256`,
      );
      expect(log.bytesRead).toBe(256);
      expect(log.content.length).toBe(256);
      expect(log.nextOffset).toBe(256);
      expect(log.truncated).toBe(true);

      // Tail from byte 1000 → 24 bytes left, not truncated.
      const tail = await getJson<{ content: string; bytesRead: number; truncated: boolean }>(
        `${baseUrl}/api/scheduled-agents/${agentId}/runs/${runId}/log?offset=1000&maxBytes=512`,
      );
      expect(tail.bytesRead).toBe(24);
      expect(tail.content.length).toBe(24);
      expect(tail.truncated).toBe(false);

      // 404 when the runId doesn't belong to the agent.
      const wrong = await fetch(`${baseUrl}/api/scheduled-agents/${agentId}/runs/missing/log`);
      expect(wrong.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  }, 25_000);

  it("POST /run maps the four overlap-policy outcomes to HTTP envelopes (skip/queue/queue_full)", async () => {
    const fixture = createFixture();
    const git = createGitRepo(fixture.config.dataDir);
    const now = new Date().toISOString();
    fixture.store.insertRepo({
      id: "repo_run_envelope",
      name: "Sched repo",
      rootPath: git.repoPath,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      // Skip-policy agent: in-flight run + POST /run → 409.
      const skipAgent = await postJson<{ scheduledAgent: { id: string } }>(`${baseUrl}/api/scheduled-agents`, {
        name: "Skip envelope",
        cron: "0 9 * * *",
        repoId: "repo_run_envelope",
        runtimeId: "shell",
        workspaceStrategy: "existing",
        workspaceName: "skip-env",
        overlapPolicy: "skip",
      });
      fixture.store.insertScheduledAgentRun({
        id: "inflight_skip",
        scheduledAgentId: skipAgent.scheduledAgent.id,
        status: "running",
        enqueuedAt: now,
        startedAt: now,
        endedAt: null,
        message: null,
        workspaceId: null,
        sessionId: null,
        backgroundSessionId: null,
        logFilePath: null,
      });
      const skipResp = await fetch(`${baseUrl}/api/scheduled-agents/${skipAgent.scheduledAgent.id}/run`, {
        method: "POST",
      });
      expect(skipResp.status).toBe(409);
      expect((await skipResp.json()) as { error: string }).toMatchObject({ error: "run_already_in_progress" });

      // Queue-policy agent: in-flight + POST /run → 202 queued.
      const queueAgent = await postJson<{ scheduledAgent: { id: string } }>(`${baseUrl}/api/scheduled-agents`, {
        name: "Queue envelope",
        cron: "0 9 * * *",
        repoId: "repo_run_envelope",
        runtimeId: "shell",
        workspaceStrategy: "existing",
        workspaceName: "queue-env",
        overlapPolicy: "queue",
      });
      fixture.store.insertScheduledAgentRun({
        id: "inflight_queue",
        scheduledAgentId: queueAgent.scheduledAgent.id,
        status: "running",
        enqueuedAt: now,
        startedAt: now,
        endedAt: null,
        message: null,
        workspaceId: null,
        sessionId: null,
        backgroundSessionId: null,
        logFilePath: null,
      });
      const queueResp = await fetch(`${baseUrl}/api/scheduled-agents/${queueAgent.scheduledAgent.id}/run`, {
        method: "POST",
      });
      expect(queueResp.status).toBe(202);
      const queueBody = (await queueResp.json()) as { queued: boolean; runId: string; queuePosition: number };
      expect(queueBody.queued).toBe(true);
      expect(queueBody.runId).toMatch(/^run_/);
      expect(queueBody.queuePosition).toBe(1);

      // Saturate the queue and verify 429 queue_full.
      for (let i = 0; i < 9; i += 1) {
        fixture.store.insertScheduledAgentRun({
          id: `queued_full_${i}`,
          scheduledAgentId: queueAgent.scheduledAgent.id,
          status: "queued",
          enqueuedAt: now,
          startedAt: null,
          endedAt: null,
          message: null,
          workspaceId: null,
          sessionId: null,
          backgroundSessionId: null,
          logFilePath: null,
        });
      }
      const fullResp = await fetch(`${baseUrl}/api/scheduled-agents/${queueAgent.scheduledAgent.id}/run`, {
        method: "POST",
      });
      expect(fullResp.status).toBe(429);
      expect((await fullResp.json()) as { error: string; limit: number }).toMatchObject({
        error: "queue_full",
        limit: 10,
      });
    } finally {
      await closeServer(server);
    }
  }, 30_000);

  it("rejects invalid query parameters with 400", async () => {
    const fixture = createFixture();
    const git = createGitRepo(fixture.config.dataDir);
    fixture.store.insertRepo({
      id: "repo_q",
      name: "Sched repo",
      rootPath: git.repoPath,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: [],
      deployHookCommand: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      archivedAt: null,
    });
    const { server } = await createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const created = await postJson<{ scheduledAgent: { id: string } }>(`${baseUrl}/api/scheduled-agents`, {
        name: "Q",
        cron: "0 9 * * *",
        repoId: "repo_q",
        runtimeId: "shell",
        workspaceStrategy: "existing",
        workspaceName: "q",
      });
      // limit=garbage → 400 invalid_integer, not silent fallback to 50.
      const bad = await fetch(`${baseUrl}/api/scheduled-agents/${created.scheduledAgent.id}/runs?limit=abc`);
      expect(bad.status).toBe(400);
      expect((await bad.json()) as { error: string; field: string }).toEqual({
        error: "invalid_integer",
        field: "limit",
      });
      // limit=0 → 400 out_of_range (min is 1).
      const zero = await fetch(`${baseUrl}/api/scheduled-agents/${created.scheduledAgent.id}/runs?limit=0`);
      expect(zero.status).toBe(400);
    } finally {
      await closeServer(server);
    }
  }, 15_000);
});

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-sched-routes-"));
  dirs.push(dir);
  const configPath = path.join(dir, "citadel.config.json");
  const config = loadConfig(configPath);
  config.dataDir = dir;
  config.databasePath = path.join(dir, "citadel.sqlite");
  config.providers = {
    github: { enabled: false, command: "gh" },
    jira: { enabled: false, command: "jtk" },
  };
  config.runtimes = [{ id: "shell", displayName: "Shell", command: "bash", args: ["-l"] }];
  const store = new SqliteStore(config.databasePath);
  store.migrate();
  return { config, configPath, store, enableRefreshJob: false };
}

function createGitRepo(dir: string) {
  const repoPath = path.join(dir, `repo-${Date.now().toString(36)}`);
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@example.test"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Citadel Test"], { cwd: repoPath, stdio: "pipe" });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repoPath, stdio: "pipe" });
  execFileSync("git", ["branch", "-M", "main"], { cwd: repoPath, stdio: "pipe" });
  return { repoPath };
}

function listen(server: http.Server) {
  return new Promise<string>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Expected TCP test server address");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server: http.Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function getJson<T>(url: string) {
  const response = await fetch(url);
  expect(response.ok).toBe(true);
  return response.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.clone().text();
  expect(response.ok, text).toBe(true);
  return response.json() as Promise<T>;
}

async function removeFixtureDir(dir: string) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["ENOTEMPTY", "EBUSY", "EPERM"].includes(code ?? "") || attempt === 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
