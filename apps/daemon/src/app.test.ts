import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "@citadel/config";
import { SqliteStore } from "@citadel/db";
import type { OperationService } from "@citadel/operations";
import { afterEach, describe, expect, it } from "vitest";
import { createDaemonApp } from "./app.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("createDaemonApp", () => {
  it("serves config, runtime, MCP, and error endpoints without starting the production listener", async () => {
    const fixture = createFixture();
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const configResponse = await getJson<{ configPath: string; config: { mcp: { enabled: boolean } } }>(
        `${baseUrl}/api/config`,
      );
      expect(configResponse.configPath).toBe(fixture.configPath);
      expect(configResponse.config.mcp.enabled).toBe(true);

      const updated = await putJson<{
        config: { mcp: { enabled: boolean }; providers: { jira: { enabled: boolean } } };
      }>(`${baseUrl}/api/config`, {
        mcp: { enabled: false },
        providers: { github: { enabled: false }, jira: { enabled: false } },
      });
      expect(updated.config.mcp.enabled).toBe(false);
      expect(updated.config.providers.jira.enabled).toBe(false);
      expect(JSON.parse(fs.readFileSync(fixture.configPath, "utf8")).mcp.enabled).toBe(false);
      expect(
        (await getJson<{ activity: Array<{ type: string }> }>(`${baseUrl}/api/activity`)).activity[0],
      ).toMatchObject({
        type: "settings.updated",
      });

      const invalidConfig = await fetch(`${baseUrl}/api/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hooks: [{ id: "setup", event: "workspace.setup", command: "true", cwd: "relative" }],
        }),
      });
      expect(invalidConfig.status).toBe(400);
      expect(await invalidConfig.json()).toMatchObject({
        error: "validation_failed",
        issues: [expect.objectContaining({ path: "hooks.0.cwd" })],
      });

      const mcpStatus = await getJson<{ enabled: boolean }>(`${baseUrl}/api/mcp/status`);
      expect(mcpStatus.enabled).toBe(false);

      const disabledToolCall = await fetch(`${baseUrl}/api/mcp/tools/call`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tool: "inspect_status" }),
      });
      expect(disabledToolCall.status).toBe(503);

      const missingRuntime = await fetch(`${baseUrl}/api/agent-sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspaceId: "ws_missing", runtimeId: "missing" }),
      });
      expect(missingRuntime.status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it("serves read-only state resources and normalized API errors", async () => {
    const fixture = createFixture();
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      expect(await getJson<{ ok: boolean; degradedProviders: number }>(`${baseUrl}/api/health`)).toMatchObject({
        ok: true,
        degradedProviders: 2,
      });
      expect(
        await getJson<{ repos: unknown[]; workspaces: unknown[]; sessions: unknown[] }>(`${baseUrl}/api/state`),
      ).toMatchObject({
        repos: [],
        workspaces: [],
        sessions: [],
      });
      expect(await getJson<{ repos: unknown[] }>(`${baseUrl}/api/repos`)).toEqual({ repos: [] });
      expect(await getJson<{ workspaces: unknown[] }>(`${baseUrl}/api/workspaces`)).toEqual({ workspaces: [] });
      expect(await getJson<{ repos: unknown[] }>(`${baseUrl}/api/mcp/resources/repos`)).toEqual({ repos: [] });
      expect(
        await getJson<{ providerHealth: unknown[] }>(`${baseUrl}/api/mcp/resources/provider-health`),
      ).toMatchObject({
        providerHealth: [expect.objectContaining({ id: "github-gh" }), expect.objectContaining({ id: "jira-jtk" })],
      });
      expect(await getJson<{ runtimes: unknown[] }>(`${baseUrl}/api/runtimes`)).toMatchObject({
        runtimes: [expect.objectContaining({ id: "shell" })],
      });
      expect(
        await getJson<{ usage: { runtimeId: string; status: string } }>(`${baseUrl}/api/runtimes/shell/usage`),
      ).toMatchObject({
        usage: { runtimeId: "shell", status: "unavailable" },
      });
      expect(await getJson<{ activity: unknown[] }>(`${baseUrl}/api/activity`)).toEqual({ activity: [] });
      expect(await getJson<{ activity: unknown[] }>(`${baseUrl}/api/mcp/resources/activity`)).toEqual({
        activity: [],
      });
      expect(
        await getJson<{ repos: unknown[]; workspaces: unknown[]; sessions: unknown[] }>(
          `${baseUrl}/api/mcp/resources/workspaces`,
        ),
      ).toEqual({ repos: [], workspaces: [], sessions: [] });
      expect(
        await postJson<{ result: { repos: number; workspaces: number; sessions: number } }>(
          `${baseUrl}/api/mcp/tools/call`,
          {
            name: "inspect_status",
          },
        ),
      ).toMatchObject({ result: { repos: 0, workspaces: 0, sessions: 0 } });
      expect(
        await postJson<{ result: { tools: Array<{ name: string }> } }>(`${baseUrl}/api/mcp/rpc`, {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        }),
      ).toMatchObject({
        result: {
          tools: expect.arrayContaining([
            expect.objectContaining({ name: "create_workspace" }),
            expect.objectContaining({ name: "list_workspace_links" }),
          ]),
        },
      });
      expect(
        await postJson<{ result: { content: Array<{ json: { repos: number } }> } }>(`${baseUrl}/api/mcp/rpc`, {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "inspect_status" },
        }),
      ).toMatchObject({
        result: { content: [expect.objectContaining({ json: expect.objectContaining({ repos: 0 }) })] },
      });
      expect(
        await postJson<{ result: { contents: Array<{ json: { workspaces: unknown[] } }> } }>(`${baseUrl}/api/mcp/rpc`, {
          jsonrpc: "2.0",
          id: 3,
          method: "resources/read",
          params: { uri: "citadel://workspaces" },
        }),
      ).toMatchObject({
        result: { contents: [expect.objectContaining({ json: { repos: [], workspaces: [], sessions: [] } })] },
      });
      expect(
        await postJson<{ result: { contents: Array<{ json: { providerHealth: unknown[] } }> } }>(
          `${baseUrl}/api/mcp/rpc`,
          {
            jsonrpc: "2.0",
            id: 4,
            method: "resources/read",
            params: { uri: "citadel://provider-health" },
          },
        ),
      ).toMatchObject({
        result: {
          contents: [
            expect.objectContaining({
              json: {
                providerHealth: [
                  expect.objectContaining({ id: "github-gh" }),
                  expect.objectContaining({ id: "jira-jtk" }),
                ],
              },
            }),
          ],
        },
      });
      expect(
        await postJson<{ result: { contents: Array<{ json: { activity: unknown[] } }> } }>(`${baseUrl}/api/mcp/rpc`, {
          jsonrpc: "2.0",
          id: 5,
          method: "resources/read",
          params: { uri: "citadel://activity" },
        }),
      ).toMatchObject({
        result: { contents: [expect.objectContaining({ json: { activity: [] } })] },
      });

      expect((await fetch(`${baseUrl}/api/repos/repo_missing/provider-summary`)).status).toBe(404);
      expect((await fetch(`${baseUrl}/api/workspaces/ws_missing/diff`)).status).toBe(404);
      expect(
        (
          await fetch(`${baseUrl}/api/repos`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await fetch(`${baseUrl}/api/workspaces`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ repoId: "bad id", name: "" }),
          })
        ).status,
      ).toBe(400);
    } finally {
      await closeServer(server);
    }
  });

  it("caches provider summaries and clears them on config updates", async () => {
    const fixture = createFixture();
    const now = new Date().toISOString();
    fixture.store.insertRepo({
      id: "repo_cache",
      name: "Cache Repo",
      rootPath: fixture.config.dataDir,
      defaultBranch: "main",
      defaultRemote: "origin",
      worktreeParent: path.join(fixture.config.dataDir, "worktrees"),
      setupHookIds: [],
      teardownHookIds: [],
      providerIds: ["github-gh"],
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    });
    let calls = 0;
    const { server } = createDaemonApp({
      ...fixture,
      providers: {
        collectGitHubVersionControlSummary: async () => {
          calls += 1;
          return {
            providerId: "github-gh",
            status: "healthy",
            reason: null,
            defaultBranch: "main",
            currentBranch: "main",
            remotes: ["origin"],
            pullRequest: null,
            checkedAt: new Date().toISOString(),
          };
        },
      },
    });
    const baseUrl = await listen(server);
    try {
      await getJson(`${baseUrl}/api/repos/repo_cache/provider-summary`);
      await getJson(`${baseUrl}/api/repos/repo_cache/provider-summary`);
      expect(calls).toBe(1);

      await putJson(`${baseUrl}/api/config`, {
        providers: { github: { enabled: true }, jira: { enabled: false } },
      });
      await getJson(`${baseUrl}/api/repos/repo_cache/provider-summary`);
      expect(calls).toBe(2);
    } finally {
      await closeServer(server);
    }
  });

  it("starts agent sessions through the MCP JSON-RPC tool surface", async () => {
    const fixture = createFixture();
    let runtimeCommand = "";
    const operations = {
      createAgentSession: async (
        input: { workspaceId: string; runtimeId: string; displayName?: string },
        runtime: { command: string },
      ) => {
        runtimeCommand = runtime.command;
        return {
          id: "sess_mcp",
          workspaceId: input.workspaceId,
          runtimeId: input.runtimeId,
          displayName: input.displayName ?? "MCP Shell",
          status: "running",
          transport: "disconnected",
          tmuxSessionName: "citadel_mcp",
          tmuxSessionId: "$mcp",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      },
    } as unknown as OperationService;
    const { server } = createDaemonApp({ ...fixture, operations });
    const baseUrl = await listen(server);
    try {
      const response = await postJson<{ result: { content: Array<{ json: { session: { id: string } } }> } }>(
        `${baseUrl}/api/mcp/rpc`,
        {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "start_agent_session",
            arguments: { workspaceId: "ws_test", runtimeId: "shell", displayName: "MCP Shell" },
          },
        },
      );

      expect(response.result.content[0]?.json.session.id).toBe("sess_mcp");
      expect(runtimeCommand).toBe("bash");
    } finally {
      await closeServer(server);
    }
  });
});

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-daemon-"));
  dirs.push(dir);
  const configPath = path.join(dir, "citadel.config.json");
  const config = loadConfig(configPath);
  config.dataDir = dir;
  config.databasePath = path.join(dir, "citadel.sqlite");
  config.providers = { github: { enabled: false }, jira: { enabled: false } };
  config.runtimes = [{ id: "shell", displayName: "Shell", command: "bash", args: ["-l"] }];
  const store = new SqliteStore(config.databasePath);
  store.migrate();
  return { config, configPath, store };
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

async function putJson<T>(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.clone().text();
  expect(response.ok, text).toBe(true);
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
