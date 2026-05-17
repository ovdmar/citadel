import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "@citadel/config";
import { SqliteStore } from "@citadel/db";
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
      expect(await getJson<{ runtimes: unknown[] }>(`${baseUrl}/api/runtimes`)).toMatchObject({
        runtimes: [expect.objectContaining({ id: "shell" })],
      });
      expect(await getJson<{ activity: unknown[] }>(`${baseUrl}/api/activity`)).toEqual({ activity: [] });
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
  expect(response.ok).toBe(true);
  return response.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok).toBe(true);
  return response.json() as Promise<T>;
}
