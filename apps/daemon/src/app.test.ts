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
