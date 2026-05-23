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

process.env.CITADEL_DISABLE_REAPER = "1";

describe("scratchpad HTTP + MCP routes", () => {
  it("round-trips content via GET and PUT /api/scratchpad", async () => {
    const fixture = createFixture();
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const initial = await getJson<{ content: string; updatedAt: string }>(`${baseUrl}/api/scratchpad`);
      expect(initial.content).toContain("Scratchpad");
      expect(initial.updatedAt).toMatch(/T.*Z$/);

      const next = await putJson<{ content: string; updatedAt: string }>(`${baseUrl}/api/scratchpad`, {
        content: "remember to ship",
      });
      expect(next.content).toBe("remember to ship");

      const refetch = await getJson<{ content: string }>(`${baseUrl}/api/scratchpad`);
      expect(refetch.content).toBe("remember to ship");
    } finally {
      await closeServer(server);
    }
  });

  it("PUTs issued in series leave the last writer's content on disk", async () => {
    // Mirrors the cockpit's single-flight save loop: even if a client fires
    // back-to-back PUTs, the final disk state must match the final body —
    // catches regressions where an out-of-order write would clobber the latest.
    const fixture = createFixture();
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const bodies = ["one", "two", "three", "four", "five"];
      for (const content of bodies) {
        await putJson(`${baseUrl}/api/scratchpad`, { content });
      }
      const final = await getJson<{ content: string }>(`${baseUrl}/api/scratchpad`);
      expect(final.content).toBe("five");
    } finally {
      await closeServer(server);
    }
  });

  it("rejects oversize PUT bodies", async () => {
    const fixture = createFixture();
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const tooLarge = "x".repeat(1_000_001);
      const response = await fetch(`${baseUrl}/api/scratchpad`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: tooLarge }),
      });
      expect(response.status).toBe(413);
    } finally {
      await closeServer(server);
    }
  });

  it("exposes read_scratchpad and write_scratchpad through MCP", async () => {
    const fixture = createFixture();
    const { server } = createDaemonApp(fixture);
    const baseUrl = await listen(server);
    try {
      const list = await postJson<{ result: { tools: Array<{ name: string }> } }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "list",
        method: "tools/list",
      });
      const toolNames = list.result.tools.map((tool) => tool.name);
      expect(toolNames).toEqual(expect.arrayContaining(["read_scratchpad", "write_scratchpad", "append_scratchpad"]));

      const write = await postJson<{ result: { structuredContent: { content: string } } }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "write",
        method: "tools/call",
        params: { name: "write_scratchpad", arguments: { content: "via mcp" } },
      });
      expect(write.result.structuredContent.content).toBe("via mcp");

      const read = await postJson<{ result: { structuredContent: { content: string } } }>(`${baseUrl}/api/mcp/rpc`, {
        jsonrpc: "2.0",
        id: "read",
        method: "tools/call",
        params: { name: "read_scratchpad" },
      });
      expect(read.result.structuredContent.content).toBe("via mcp");

      const appended = await postJson<{ result: { structuredContent: { content: string } } }>(
        `${baseUrl}/api/mcp/rpc`,
        {
          jsonrpc: "2.0",
          id: "append",
          method: "tools/call",
          params: { name: "append_scratchpad", arguments: { content: "more" } },
        },
      );
      expect(appended.result.structuredContent.content).toBe("via mcp\n\nmore\n");

      // Oversize writes return a structured sentinel rather than throwing, so
      // an orchestrator agent can branch on { error } instead of catching a
      // JSON-RPC error envelope.
      const oversize = await postJson<{ result: { structuredContent: { error: string; limit: number } } }>(
        `${baseUrl}/api/mcp/rpc`,
        {
          jsonrpc: "2.0",
          id: "oversize",
          method: "tools/call",
          params: { name: "write_scratchpad", arguments: { content: "x".repeat(1_000_001) } },
        },
      );
      expect(oversize.result.structuredContent).toMatchObject({ error: "scratchpad_too_large", limit: 1_000_000 });
    } finally {
      await closeServer(server);
    }
  });
});

function createFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "citadel-scratchpad-routes-"));
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
